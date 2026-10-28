import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { AI_ENGINE, startAiEngineInstall, uninstallAiEngine } from "./ai-engine";
import { installAiEngine } from "./ai-install";

const files: Record<string, Buffer> = {
  "/ComfyUI_windows_portable_nvidia.7z": randomBytes(50_000),
  "/model.safetensors": randomBytes(40_000),
  "/vae.safetensors": randomBytes(10_000),
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let server: Server;
let base: string;
let root: string;
let requested: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ai-install-test-"));
  server = createServer((request, response) => {
    requested.push(request.url!);
    const bytes = files[request.url!];
    if (!bytes) {
      response.writeHead(404).end();
      return;
    }
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

// The real manifest's shape, pointing at the local server.
function testEngine(): typeof AI_ENGINE {
  const archive = files["/ComfyUI_windows_portable_nvidia.7z"];
  return {
    comfyui: {
      ...AI_ENGINE.comfyui,
      url: `${base}/ComfyUI_windows_portable_nvidia.7z`,
      sha256: sha(archive),
      size: archive.length,
      unpackedSize: 1000,
    },
    models: [
      { ...AI_ENGINE.models[0], folder: "diffusion_models", file: "model.safetensors", url: `${base}/model.safetensors`, sha256: sha(files["/model.safetensors"]), size: files["/model.safetensors"].length },
      { ...AI_ENGINE.models[2], folder: "vae", file: "vae.safetensors", url: `${base}/vae.safetensors`, sha256: sha(files["/vae.safetensors"]), size: files["/vae.safetensors"].length },
    ],
  };
}

function fakeDb(status = "installing") {
  const state = { engine: { id: 1, status } as Record<string, unknown>, writes: [] as Record<string, unknown>[], busyJobs: 0 };
  const db = {
    aiEngine: {
      findUnique: async () => ({ ...state.engine }),
      upsert: async ({ update }: { update: Record<string, unknown> }) => {
        state.writes.push(update);
        Object.assign(state.engine, update);
        return state.engine;
      },
    },
    aiVideoJob: { count: async () => state.busyJobs },
  };
  return { db: db as unknown as PrismaClient, state };
}

// Stands in for 7zr: makes the folders the portable build has.
async function fakeExtract(archive: string, into: string) {
  expect((await readFile(archive)).equals(files["/ComfyUI_windows_portable_nvidia.7z"])).toBe(true);
  const comfy = path.join(into, "ComfyUI_windows_portable");
  await mkdir(path.join(comfy, "python_embeded"), { recursive: true });
  await writeFile(path.join(comfy, "python_embeded", "python.exe"), "python");
  await mkdir(path.join(comfy, "ComfyUI", "models", "vae"), { recursive: true });
}

describe("installAiEngine", () => {
  it("downloads ComfyUI, unpacks it, puts the models in their folders and records the size", async () => {
    const dir = path.join(root, "fresh", "ai");
    const { db, state } = fakeDb();
    requested = [];
    await installAiEngine({ db, dir, engine: testEngine(), extract: fakeExtract });

    const models = path.join(dir, "ComfyUI_windows_portable", "ComfyUI", "models");
    expect((await readFile(path.join(models, "diffusion_models", "model.safetensors"))).equals(files["/model.safetensors"])).toBe(true);
    expect((await readFile(path.join(models, "vae", "vae.safetensors"))).equals(files["/vae.safetensors"])).toBe(true);
    // The archive is gone once unpacked; a marker says the unpack finished.
    expect((await readdir(dir)).sort()).toEqual(["ComfyUI_windows_portable", "comfyui-v0.43.0.unpacked"]);
    expect(state.engine).toMatchObject({ status: "installed", step: null, percent: null, error: null });
    expect(state.engine.installedBytes).toBe(BigInt(40_000 + 10_000 + "python".length));
    expect(state.writes.map((write) => write.step).filter(Boolean)).toEqual([
      "Downloading ComfyUI",
      "Unpacking ComfyUI (this takes a few minutes)",
      "Downloading Wan 2.2 TI2V 5B video model",
      "Downloading Wan 2.2 VAE",
      "Measuring the installed files",
    ]);
  });

  it("after a failure, fetches only what is missing", async () => {
    const dir = path.join(root, "retry", "ai");
    const engine = testEngine();
    const broken = { ...engine, models: [engine.models[0], { ...engine.models[1], url: `${base}/missing` }] };
    const first = fakeDb();
    await expect(installAiEngine({ db: first.db, dir, engine: broken, extract: fakeExtract })).rejects.toThrow("HTTP 404");
    expect(first.state.engine).toMatchObject({ status: "failed", step: null, error: expect.stringContaining("HTTP 404") });

    requested = [];
    const second = fakeDb();
    let unpacked = 0;
    await installAiEngine({ db: second.db, dir, engine, extract: async () => void unpacked++ });
    expect(requested).toEqual(["/vae.safetensors"]);
    expect(unpacked).toBe(0);
    expect(second.state.engine.status).toBe("installed");
  });

  it("refuses a data folder whose path is too long for ComfyUI's files", async () => {
    const dir = path.join(root, "x".repeat(80), "ai");
    const { db, state } = fakeDb();
    await expect(installAiEngine({ db, dir, engine: testEngine(), extract: fakeExtract })).rejects.toThrow("path is too long");
    expect(state.engine.status).toBe("failed");
  });

  it("refuses to start without enough free disk space", async () => {
    const dir = path.join(root, "full", "ai");
    const { db } = fakeDb();
    const huge = { ...testEngine(), comfyui: { ...testEngine().comfyui, unpackedSize: 1e18 } };
    await expect(installAiEngine({ db, dir, engine: huge, extract: fakeExtract })).rejects.toThrow("not enough free disk space");
  });
});

describe("startAiEngineInstall and uninstallAiEngine", () => {
  it("queues an install once", async () => {
    const { db, state } = fakeDb("not_installed");
    let sent = 0;
    await startAiEngineInstall({ db, queue: { send: async () => (sent++, "id") } });
    expect(state.engine).toMatchObject({ status: "installing", percent: 0, error: null });
    await expect(startAiEngineInstall({ db, queue: { send: async () => "id" } })).rejects.toThrow("already being installed");
    expect(sent).toBe(1);
  });

  it("deletes the folder, but not while a video is being made", async () => {
    const dir = path.join(root, "remove", "ai");
    await mkdir(dir, { recursive: true });
    const { db, state } = fakeDb("installed");
    state.busyJobs = 1;
    await expect(uninstallAiEngine({ db, dir })).rejects.toThrow("AI videos being made");
    state.busyJobs = 0;
    await uninstallAiEngine({ db, dir });
    await expect(stat(dir)).rejects.toThrow();
    expect(state.engine).toMatchObject({ status: "not_installed", installedBytes: null });
  });
});
