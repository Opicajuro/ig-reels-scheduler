import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  engineDownloadBytes,
  installSlideshowEngine,
  pictureMakerPaths,
  scriptWriterPaths,
  SLIDESHOW_ENGINES,
  startSlideshowEngineInstall,
  uninstallSlideshowEngine,
  type EngineManifest,
} from "./slideshow-engines";

const files: Record<string, Buffer> = {
  "/llama.zip": randomBytes(30_000),
  "/model.gguf": randomBytes(50_000),
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let server: Server;
let base: string;
let root: string;
let requested: string[] = [];

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slideshow-engines-test-"));
  // Serves the files like GitHub and Hugging Face do, and /damaged with other bytes than its pinned hash.
  server = createServer((request, response) => {
    requested.push(request.url!);
    const bytes = request.url === "/damaged" ? Buffer.alloc(files["/model.gguf"].length, 7) : files[request.url!];
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

// The real script writer manifest's shape, pointing at the local server.
function testManifest(): EngineManifest {
  const [program, model] = SLIDESHOW_ENGINES.script.files;
  return {
    name: SLIDESHOW_ENGINES.script.name,
    files: [
      { ...program, url: `${base}/llama.zip`, sha256: sha(files["/llama.zip"]), size: files["/llama.zip"].length },
      { ...model, url: `${base}/model.gguf`, sha256: sha(files["/model.gguf"]), size: files["/model.gguf"].length },
    ],
  };
}

function fakeDb(status = "installing") {
  const state = { engine: { id: "script", status } as Record<string, unknown>, writes: [] as Record<string, unknown>[], busyJobs: 0 };
  const db = {
    slideshowEngine: {
      findUnique: async () => ({ ...state.engine }),
      upsert: async ({ update }: { update: Record<string, unknown> }) => {
        state.writes.push(update);
        Object.assign(state.engine, update);
        return state.engine;
      },
    },
    slideshowJob: { count: async () => state.busyJobs },
  };
  return { db: db as unknown as PrismaClient, state };
}

// Stands in for tar: puts the programs the zip holds in place.
async function fakeUnzip(archive: string, into: string) {
  expect((await readFile(archive)).equals(files["/llama.zip"])).toBe(true);
  await writeFile(path.join(into, "llama-server.exe"), "server");
}

describe("the pinned manifest", () => {
  it("pins every download by an https URL at a fixed release or commit, its size and its sha256", () => {
    for (const engine of Object.values(SLIDESHOW_ENGINES)) {
      for (const file of engine.files) {
        expect(file.url).toMatch(/^https:\/\/(github\.com\/[^/]+\/[^/]+\/releases\/download\/|huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/)/);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.size).toBeGreaterThan(0);
      }
    }
    // About 2.7 GB and about 6 GB, as Settings says.
    expect(engineDownloadBytes(SLIDESHOW_ENGINES.script) / 1e9).toBeCloseTo(2.8, 0);
    expect(engineDownloadBytes(SLIDESHOW_ENGINES.picture) / 1e9).toBeCloseTo(6.7, 0);
  });

  it("knows where each program and model ends up", () => {
    const script = scriptWriterPaths(path.join("data", "slideshow"));
    expect(script.model).toBe(path.join("data", "slideshow", "script", "Qwen3.5-4B-Q4_K_M.gguf"));
    expect(path.dirname(script.server)).toBe(path.join("data", "slideshow", "script", "llama"));
    const picture = pictureMakerPaths(path.join("data", "slideshow"));
    expect(picture.vae).toBe(path.join("data", "slideshow", "picture", "ae.safetensors"));
    expect(path.dirname(picture.cli)).toBe(path.join("data", "slideshow", "picture", "sd"));
  });
});

describe("installSlideshowEngine", () => {
  it("downloads and checks each file, unpacks the program, and records the size", async () => {
    const dir = path.join(root, "fresh");
    const { db, state } = fakeDb();
    requested = [];
    await installSlideshowEngine({ db, root: dir, engine: "script", manifest: testManifest(), unzip: fakeUnzip });

    const engineDir = path.join(dir, "script");
    expect((await readFile(path.join(engineDir, "Qwen3.5-4B-Q4_K_M.gguf"))).equals(files["/model.gguf"])).toBe(true);
    expect(await readFile(path.join(engineDir, "llama", "llama-server.exe"), "utf8")).toBe("server");
    // The zip is gone once unpacked; a marker says the unpack finished.
    expect((await readdir(engineDir)).sort()).toEqual(["Qwen3.5-4B-Q4_K_M.gguf", "llama", "llama-b12017-bin-win-vulkan-x64.zip.unpacked"]);
    expect(requested).toEqual(["/llama.zip", "/model.gguf"]);
    expect(state.engine).toMatchObject({ status: "installed", step: null, percent: null, error: null });
    expect(state.engine.installedBytes).toBe(BigInt(50_000 + "server".length));
    expect(state.writes.map((write) => write.step).filter(Boolean)).toEqual([
      "Downloading llama.cpp",
      "Unpacking llama.cpp",
      "Downloading the Qwen3.5 4B model",
      "Measuring the installed files",
    ]);
  });

  it("deletes a download whose sha256 does not match, and a second try fetches only what is missing", async () => {
    const dir = path.join(root, "damaged");
    const manifest = testManifest();
    const damaged = { ...manifest, files: [manifest.files[0], { ...manifest.files[1], url: `${base}/damaged` }] };
    const first = fakeDb();
    await expect(installSlideshowEngine({ db: first.db, root: dir, engine: "script", manifest: damaged, unzip: fakeUnzip })).rejects.toThrow(
      "is damaged",
    );
    expect(first.state.engine).toMatchObject({ status: "failed", error: expect.stringContaining("is damaged") });
    await expect(stat(path.join(dir, "script", "Qwen3.5-4B-Q4_K_M.gguf"))).rejects.toThrow();
    await expect(stat(path.join(dir, "script", "Qwen3.5-4B-Q4_K_M.gguf.part"))).rejects.toThrow();

    requested = [];
    let unzipped = 0;
    const second = fakeDb();
    await installSlideshowEngine({ db: second.db, root: dir, engine: "script", manifest, unzip: async () => void unzipped++ });
    expect(requested).toEqual(["/model.gguf"]);
    expect(unzipped).toBe(0);
    expect(second.state.engine.status).toBe("installed");
  });

  it("refuses a file that is not pinned yet, before downloading anything", async () => {
    const manifest = testManifest();
    const unpinned = { ...manifest, files: [manifest.files[0], { ...manifest.files[1], sha256: null }] };
    const { db, state } = fakeDb();
    requested = [];
    await expect(installSlideshowEngine({ db, root: path.join(root, "unpinned"), engine: "script", manifest: unpinned, unzip: fakeUnzip })).rejects.toThrow(
      "the Qwen3.5 4B model is not pinned yet",
    );
    expect(requested).toEqual([]);
    expect(state.engine.status).toBe("failed");
  });

  it("refuses to start without enough free disk space", async () => {
    const manifest = testManifest();
    const huge = { ...manifest, files: [{ ...manifest.files[0], size: 1e18 }] };
    const { db } = fakeDb();
    await expect(installSlideshowEngine({ db, root: path.join(root, "full"), engine: "script", manifest: huge, unzip: fakeUnzip })).rejects.toThrow(
      "not enough free disk space",
    );
  });
});

describe("startSlideshowEngineInstall and uninstallSlideshowEngine", () => {
  it("queues an install once", async () => {
    const { db, state } = fakeDb("not_installed");
    const sent: string[] = [];
    await startSlideshowEngineInstall({ db, queue: { send: async (engine) => (sent.push(engine), "id") }, engine: "script" });
    expect(state.engine).toMatchObject({ status: "installing", percent: 0, error: null });
    await expect(startSlideshowEngineInstall({ db, queue: { send: async () => "id" }, engine: "script" })).rejects.toThrow(
      "already being installed",
    );
    expect(sent).toEqual(["script"]);
  });

  it("deletes the engine's folder only, but not while a slideshow is being made", async () => {
    const dir = path.join(root, "remove");
    await mkdir(path.join(dir, "script"), { recursive: true });
    await mkdir(path.join(dir, "picture"), { recursive: true });
    const { db, state } = fakeDb("installed");
    state.busyJobs = 1;
    await expect(uninstallSlideshowEngine({ db, root: dir, engine: "script" })).rejects.toThrow("slideshows being made");
    state.busyJobs = 0;
    await uninstallSlideshowEngine({ db, root: dir, engine: "script" });
    expect(await readdir(dir)).toEqual(["picture"]);
    expect(state.engine).toMatchObject({ status: "not_installed", installedBytes: null });
  });
});
