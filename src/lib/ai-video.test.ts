import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createAiVideo, runAiVideoJob } from "./ai-video";
import type { ClipStore } from "./clip-store";
import type { Workflow } from "./ai-workflow";

// A stand-in for ComfyUI's API: /system_stats, /upload/image, /prompt, /history/{id}, /view and the /ws websocket
// (just enough of RFC 6455 to send text frames). Queueing a prompt plays back the messages ComfyUI sends while it runs.
type FakeComfy = {
  url: string;
  prompts: { prompt: Workflow; client_id: string; prompt_id: string }[];
  uploads: string[];
  fail: string | null;
  close(): Promise<void>;
};

function sendText(socket: Socket, text: string) {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function startFakeComfy(video: string): Promise<FakeComfy> {
  const sockets = new Map<string, Socket>();
  const fake = { prompts: [], uploads: [], fail: null } as unknown as FakeComfy;
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fake");
    if (url.pathname === "/system_stats") {
      response.end(JSON.stringify({ system: {}, devices: [] }));
    } else if (url.pathname === "/upload/image" && request.method === "POST") {
      const form = (await body(request)).toString("latin1");
      fake.uploads.push(/filename="([^"]+)"/.exec(form)![1]);
      response.end(JSON.stringify({ name: "start.png", subfolder: "", type: "input" }));
    } else if (url.pathname === "/prompt" && request.method === "POST") {
      const queued = JSON.parse((await body(request)).toString());
      fake.prompts.push(queued);
      response.end(JSON.stringify({ prompt_id: queued.prompt_id, number: 0, node_errors: {} }));
      const socket = sockets.get(queued.client_id)!;
      const send = (type: string, data: object) => sendText(socket, JSON.stringify({ type, data }));
      const id = queued.prompt_id;
      setTimeout(() => {
        send("execution_start", { prompt_id: id });
        send("progress", { value: 3, max: 20, prompt_id: "someone-else", node: "3" });
        send("progress", { value: 1, max: 1, prompt_id: id, node: "37" });
        for (const value of [5, 10, 20]) send("progress", { value, max: 20, prompt_id: id, node: "3" });
        if (fake.fail) send("execution_error", { prompt_id: id, exception_message: fake.fail });
        else send("execution_success", { prompt_id: id });
      }, 20);
    } else if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.slice("/history/".length);
      const images = [{ filename: "localirs_00001_.mp4", subfolder: "video", type: "output" }];
      response.end(JSON.stringify({ [id]: { outputs: { "58": { images, animated: [true] } }, status: { status_str: "success" } } }));
    } else if (url.pathname === "/view" && url.searchParams.get("filename") === "localirs_00001_.mp4") {
      response.end(await readFile(video));
    } else {
      response.writeHead(404).end();
    }
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.set(new URL(request.url!, "http://fake").searchParams.get("clientId")!, socket);
    sendText(socket, JSON.stringify({ type: "status", data: { status: {}, sid: "x" } }));
    // The client's close frame ends the connection.
    socket.on("data", () => socket.destroy());
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = async () => {
    for (const socket of sockets.values()) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return fake;
}

type Row = Record<string, unknown>;

function fakeDb(job: Row, engineStatus = "installed") {
  const state = { job: { ...job }, steps: [] as string[], projects: [] as Row[], clips: [] as Row[], created: [] as Row[] };
  const db = {
    aiEngine: { findUnique: async () => ({ id: 1, status: engineStatus }) },
    aiVideoJob: {
      findUnique: async () => ({ ...state.job }),
      create: async ({ data }: { data: Row }) => {
        state.created.push(data);
        return { id: "new-job", ...data };
      },
      update: async ({ data }: { data: Row }) => {
        if (typeof data.step === "string") state.steps.push(data.step);
        Object.assign(state.job, data);
        return state.job;
      },
    },
    clipProject: {
      findFirst: async ({ where }: { where: Row }) => state.projects.find((p) => p.ownerId === where.ownerId && p.aiVideos) ?? null,
      create: async ({ data }: { data: Row }) => {
        const project = { id: `project-${state.projects.length + 1}`, ...data };
        state.projects.push(project);
        return project;
      },
    },
    clip: {
      count: async ({ where }: { where: Row }) => state.clips.filter((clip) => clip.projectId === where.projectId).length,
      create: async ({ data }: { data: Row }) => {
        state.clips.push(data);
        return data;
      },
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

let root: string;
let video: string;
let bucket: string;
let comfy: FakeComfy;

function bucketStore(): ClipStore {
  return {
    downloadTo: async (key, filePath) => copyFile(path.join(bucket, key), filePath),
    upload: async (key, filePath) => {
      await mkdir(path.dirname(path.join(bucket, key)), { recursive: true });
      await copyFile(filePath, path.join(bucket, key));
    },
    copy: async () => {},
    remove: async () => {},
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ai-video-test-"));
  video = path.join(root, "generated.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=704x1280:rate=24",
    "-frames:v", "49",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    video,
  ]);
  bucket = path.join(root, "bucket");
  await mkdir(path.join(bucket, "ai-inputs"), { recursive: true });
  await writeFile(path.join(bucket, "ai-inputs", "0b0e5e5e-1111-4222-8333-944445555666.png"), "png bytes");
  comfy = await startFakeComfy(video);
});

afterAll(async () => {
  await comfy.close();
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  comfy.prompts.length = 0;
  comfy.uploads.length = 0;
  comfy.fail = null;
});

async function run(job: Row, db: PrismaClient) {
  const workDir = await mkdtemp(path.join(root, "work-"));
  const lifecycle: string[] = [];
  const promise = runAiVideoJob({
    db,
    store: bucketStore(),
    jobId: String(job.id),
    workDir,
    startComfy: async () => {
      lifecycle.push("started");
      return { url: comfy.url, stop: async () => void lifecycle.push("stopped") };
    },
  });
  return { promise, lifecycle };
}

describe("runAiVideoJob", () => {
  it("makes a text-to-video clip in the AI videos project, with progress, and stops ComfyUI", async () => {
    const job = { id: "job-1", ownerId: "owner-1", prompt: "A fox in the snow", seconds: 5, startImageKey: null, status: "queued" };
    const { db, state } = fakeDb(job);
    const { promise, lifecycle } = await run(job, db);
    await promise;

    expect(lifecycle).toEqual(["started", "stopped"]);
    expect(comfy.uploads).toEqual([]);
    const [queued] = comfy.prompts;
    expect(queued.prompt["6"].inputs.text).toBe("A fox in the snow");
    expect(queued.prompt["55"].inputs.length).toBe(121);
    expect(queued.prompt).not.toHaveProperty("56");
    expect(state.steps).toEqual([
      "Starting the AI engine",
      "Generating video 0%",
      "Generating video 25%",
      "Generating video 50%",
      "Generating video 100%",
      "Saving the video",
      "Converting for Instagram",
      "Adding the clip",
    ]);

    expect(state.projects).toEqual([{ id: "project-1", ownerId: "owner-1", name: "AI videos", aiVideos: true, status: "done" }]);
    expect(state.clips).toHaveLength(1);
    const clip = state.clips[0];
    expect(clip).toMatchObject({ projectId: "project-1", name: "ai-001", start: 0, length: 5, aiGenerated: true });
    expect(state.job).toMatchObject({ status: "done", step: null, clipId: clip.id });

    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", path.join(bucket, String(clip.storageKey))], {
        encoding: "utf8",
      }),
    ) as { streams: { codec_type: string; width?: number; height?: number }[] };
    expect(probe.streams.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
    expect(probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
  });

  it("uploads the start picture and makes image-to-video, reusing the AI videos project", async () => {
    const job = {
      id: "job-2",
      ownerId: "owner-1",
      prompt: "The picture comes alive",
      seconds: 3,
      startImageKey: "ai-inputs/0b0e5e5e-1111-4222-8333-944445555666.png",
      status: "queued",
    };
    const { db, state } = fakeDb(job);
    state.projects.push({ id: "existing", ownerId: "owner-1", aiVideos: true });
    state.clips.push({ projectId: "existing" });
    const { promise } = await run(job, db);
    await promise;

    expect(comfy.uploads).toEqual(["start.png"]);
    const [queued] = comfy.prompts;
    expect(queued.prompt["56"]).toEqual({ class_type: "LoadImage", inputs: { image: "start.png" } });
    expect(queued.prompt["55"].inputs).toMatchObject({ length: 73, start_image: ["56", 0] });
    expect(state.projects).toHaveLength(1);
    expect(state.clips[1]).toMatchObject({ projectId: "existing", name: "ai-002", length: 3, aiGenerated: true });
  });

  it("records ComfyUI's error, stops it and makes no clip", async () => {
    comfy.fail = "Allocation on device: out of memory";
    const job = { id: "job-3", ownerId: "owner-1", prompt: "Too big", seconds: 5, startImageKey: null, status: "queued" };
    const { db, state } = fakeDb(job);
    const { promise, lifecycle } = await run(job, db);
    await expect(promise).rejects.toThrow("ComfyUI failed: Allocation on device: out of memory");
    expect(lifecycle).toEqual(["started", "stopped"]);
    expect(state.clips).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", step: null, error: "ComfyUI failed: Allocation on device: out of memory" });
  });

  it("fails before starting ComfyUI when the engine is not installed", async () => {
    const job = { id: "job-4", ownerId: "owner-1", prompt: "x", seconds: 3, startImageKey: null, status: "queued" };
    const { db, state } = fakeDb(job, "not_installed");
    const { promise, lifecycle } = await run(job, db);
    await expect(promise).rejects.toThrow("not installed");
    expect(lifecycle).toEqual([]);
    expect(state.job.status).toBe("failed");
  });
});

describe("createAiVideo", () => {
  const queue = (sent: string[]) => ({ send: async (id: string) => (sent.push(id), "pg-boss-id") });

  it("saves the request and queues it", async () => {
    const { db, state } = fakeDb({});
    const sent: string[] = [];
    await createAiVideo({ db, queue: queue(sent), ownerId: "owner-1", prompt: "  A fox  ", seconds: 3, startImageKey: null });
    expect(state.created).toEqual([{ ownerId: "owner-1", prompt: "A fox", seconds: 3, startImageKey: null }]);
    expect(sent).toEqual(["new-job"]);
  });

  it("refuses an empty prompt, another length, a foreign storage key, or a missing engine", async () => {
    const { db } = fakeDb({});
    const base = { db, queue: queue([]), ownerId: "owner-1", prompt: "A fox", seconds: 3, startImageKey: null };
    await expect(createAiVideo({ ...base, prompt: "   " })).rejects.toThrow("describe the video");
    await expect(createAiVideo({ ...base, seconds: 4 })).rejects.toThrow("3, 5 seconds");
    await expect(createAiVideo({ ...base, startImageKey: "clips/p/c.mp4" })).rejects.toThrow("not valid");
    const { db: noEngine } = fakeDb({}, "not_installed");
    await expect(createAiVideo({ ...base, db: noEngine })).rejects.toThrow("install the AI video engine first");
  });
});
