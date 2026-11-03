import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createAiClipVideo, createAiVideo, runAiVideoJob } from "./ai-video";
import type { ClipStore } from "./clip-store";
import type { Workflow } from "./ai-workflow";

// A stand-in for ComfyUI's API: /system_stats, /upload/image, /prompt, /history/{id}, /view and the /ws websocket
// (just enough of RFC 6455 to send text frames). Queueing a prompt plays back the messages ComfyUI sends while it runs.
type FakeComfy = {
  url: string;
  // The video every prompt "makes".
  video: string;
  prompts: { prompt: Workflow; client_id: string; prompt_id: string }[];
  uploads: string[];
  // The /queue and /interrupt calls, in order.
  stops: string[];
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
  const fake = { video, prompts: [], uploads: [], stops: [], fail: null } as unknown as FakeComfy;
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
    } else if ((url.pathname === "/queue" || url.pathname === "/interrupt") && request.method === "POST") {
      fake.stops.push(`${url.pathname} ${(await body(request)).toString()}`.trim());
      response.end();
    } else if (url.pathname.startsWith("/history/")) {
      const id = url.pathname.slice("/history/".length);
      const images = [{ filename: "localirs_00001_.mp4", subfolder: "video", type: "output" }];
      response.end(JSON.stringify({ [id]: { outputs: { "58": { images, animated: [true] } }, status: { status_str: "success" } } }));
    } else if (url.pathname === "/view" && url.searchParams.get("filename") === "localirs_00001_.mp4") {
      response.end(await readFile(fake.video));
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

function fakeDb(job: Row, engineStatus = "installed", onStep: (step: string, job: Row) => void = () => {}) {
  // sources are the clips intros and B-roll are made from, with their project as findFirst includes it.
  const state = {
    job: { ...job },
    steps: [] as string[],
    projects: [] as Row[],
    clips: [] as Row[],
    created: [] as Row[],
    sources: [] as (Row & { project: { ownerId: string; status: string } })[],
  };
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
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (where.status !== state.job.status) return { count: 0 };
        if (typeof data.step === "string") {
          state.steps.push(data.step);
          onStep(data.step, state.job);
        }
        Object.assign(state.job, data);
        return { count: 1 };
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
      findUnique: async ({ where }: { where: Row }) => state.sources.find((clip) => clip.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { id: string; project: { ownerId: string } } }) =>
        state.sources.find((clip) => clip.id === where.id && clip.project.ownerId === where.project.ownerId) ?? null,
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
  comfy.video = video;
  comfy.prompts.length = 0;
  comfy.uploads.length = 0;
  comfy.stops.length = 0;
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
    const job = { id: "job-1", kind: "prompt", ownerId: "owner-1", prompt: "A fox in the snow", seconds: 5, startImageKey: null, status: "queued" };
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
      kind: "prompt",
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
    const job = { id: "job-3", kind: "prompt", ownerId: "owner-1", prompt: "Too big", seconds: 5, startImageKey: null, status: "queued" };
    const { db, state } = fakeDb(job);
    const { promise, lifecycle } = await run(job, db);
    await expect(promise).rejects.toThrow("ComfyUI failed: Allocation on device: out of memory");
    expect(lifecycle).toEqual(["started", "stopped"]);
    expect(state.clips).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", step: null, error: "ComfyUI failed: Allocation on device: out of memory" });
  });

  it("stops without a clip or an error when the video is cancelled while it is made", async () => {
    const job = { id: "job-5", kind: "prompt", ownerId: "owner-1", prompt: "A fox", seconds: 3, startImageKey: null, status: "queued" };
    const { db, state } = fakeDb(job, "installed", (step, row) => {
      if (step === "Generating video 0%") Object.assign(row, { status: "failed", step: null, error: "Cancelled" });
    });
    const { promise, lifecycle } = await run(job, db);
    await promise;

    expect(lifecycle).toEqual(["started", "stopped"]);
    expect(state.steps).toEqual(["Starting the AI engine", "Generating video 0%"]);
    // The cancel came after the worker's last check, so the worker stopped ComfyUI when its progress write failed.
    expect(comfy.stops.slice(0, 2)).toEqual(['/queue {"clear":true}', "/interrupt"]);
    expect(state.clips).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", error: "Cancelled" });
  });

  it("does not start a video cancelled before the worker took it", async () => {
    const job = { id: "job-6", kind: "prompt", ownerId: "owner-1", prompt: "A fox", seconds: 3, startImageKey: null, status: "failed", error: "Cancelled" };
    const { db, state } = fakeDb(job);
    const { promise, lifecycle } = await run(job, db);
    await promise;
    expect(lifecycle).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", error: "Cancelled" });
  });

  it("fails before starting ComfyUI when the engine is not installed", async () => {
    const job = { id: "job-4", kind: "prompt", ownerId: "owner-1", prompt: "x", seconds: 3, startImageKey: null, status: "queued" };
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

// A 6 s blue 1080×1920 clip with a 44.1 kHz mono tone, and a red AI shot as Wan 2.2 5B makes it (704×1280, 24 fps,
// 5 s plus a frame, no sound).
async function clipFixtures() {
  const dir = path.join(root, "from-clip");
  await mkdir(path.join(bucket, "clips", "project-9"), { recursive: true });
  await mkdir(dir, { recursive: true });
  const source = path.join(bucket, "clips", "project-9", "source.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "6", "-ac", "1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    source,
  ]);
  const shot = path.join(dir, "red.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=704x1280:r=24",
    "-frames:v", "121",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    shot,
  ]);
  return { source, shot };
}

function probeStreams(file: string) {
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }),
  ) as { streams: { codec_type: string; width?: number; height?: number; r_frame_rate: string }[]; format: { duration: string } };
}

// The average colour of the middle of the frame at `seconds`, as "red" or "blue".
function colourAt(file: string, seconds: number): string {
  const [r, , b] = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file,
    "-frames:v", "1", "-vf", "crop=200:200,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ]);
  if (r > 200 && b < 50) return "red";
  if (b > 200 && r < 50) return "blue";
  return `rgb(${r}, ?, ${b})`;
}

function audioMd5(file: string): string {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "md5", "pipe:1"], { encoding: "utf8" }).trim();
}

const sourceClip = {
  id: "clip-9",
  projectId: "project-9",
  name: "clip-003",
  title: "Morning routine",
  description: "How I start the day",
  musicTrack: null,
  start: 42,
  length: 6,
  storageKey: "clips/project-9/source.mp4",
  project: { ownerId: "owner-1", status: "done" },
};

describe("runAiVideoJob from a clip", () => {
  let fixtures: { source: string; shot: string };
  beforeAll(async () => {
    fixtures = await clipFixtures();
  });
  beforeEach(() => {
    comfy.video = fixtures.shot;
  });

  it("makes an AI intro from the clip's first frame and joins it in front as a new clip", async () => {
    const before = audioMd5(fixtures.source);
    const job = { id: "job-i", ownerId: "owner-1", prompt: "A sunrise", seconds: 5, startImageKey: null, kind: "intro", sourceClipId: "clip-9", at: null, status: "queued" };
    const { db, state } = fakeDb(job);
    state.sources.push(sourceClip);
    const { promise, lifecycle } = await run(job, db);
    await promise;

    expect(lifecycle).toEqual(["started", "stopped"]);
    expect(comfy.uploads).toEqual(["start.png"]);
    expect(comfy.prompts[0].prompt["55"].inputs).toMatchObject({ length: 121, start_image: ["56", 0] });
    expect(state.steps).toEqual([
      "Taking the start picture",
      "Starting the AI engine",
      "Generating video 0%",
      "Generating video 25%",
      "Generating video 50%",
      "Generating video 100%",
      "Saving the video",
      "Joining the intro to the clip",
      "Adding the clip",
    ]);
    expect(state.projects).toEqual([]);
    const [clip] = state.clips;
    expect(clip).toMatchObject({
      projectId: "project-9",
      name: "clip-003 + AI intro",
      title: "Morning routine + AI intro",
      description: "How I start the day",
      start: 42,
      aiGenerated: true,
    });
    expect(Math.abs(Number(clip.length) - 11)).toBeLessThan(0.1);
    expect(state.job).toMatchObject({ status: "done", step: null, clipId: clip.id });

    const made = path.join(bucket, String(clip.storageKey));
    const probe = probeStreams(made);
    expect(Math.abs(Number(probe.format.duration) - 11)).toBeLessThan(0.1);
    expect(probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ width: 1080, height: 1920, r_frame_rate: "30/1" });
    expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
    expect([colourAt(made, 1), colourAt(made, 4.8), colourAt(made, 5.2), colourAt(made, 10)]).toEqual(["red", "red", "blue", "blue"]);
    // The original clip stays as it was.
    expect(audioMd5(fixtures.source)).toBe(before);
    expect(colourAt(fixtures.source, 1)).toBe("blue");
  }, 60_000);

  it("lays a 3 s B-roll shot over the picture at the moment while the clip's sound continues", async () => {
    const job = { id: "job-b", ownerId: "owner-1", prompt: "Coffee pouring", seconds: 3, startImageKey: null, kind: "broll", sourceClipId: "clip-9", at: 2, status: "queued" };
    const { db, state } = fakeDb(job);
    state.sources.push({ ...sourceClip, title: null });
    const { promise } = await run(job, db);
    await promise;

    expect(comfy.prompts[0].prompt["55"].inputs).toMatchObject({ length: 73, start_image: ["56", 0] });
    expect(state.steps).toContain("Laying the B-roll over the clip");
    const [clip] = state.clips;
    expect(clip).toMatchObject({ projectId: "project-9", name: "clip-003 + AI B-roll", title: "clip-003 + AI B-roll", aiGenerated: true });
    expect(Math.abs(Number(clip.length) - 6)).toBeLessThan(0.1);

    const made = path.join(bucket, String(clip.storageKey));
    expect([1.5, 2.2, 3.5, 4.8, 5.5].map((at) => colourAt(made, at))).toEqual(["blue", "red", "red", "red", "blue"]);
    expect(audioMd5(made)).toBe(audioMd5(fixtures.source));
  }, 60_000);

  it("fails before starting ComfyUI when the moment does not fit the clip's file", async () => {
    const job = { id: "job-c", ownerId: "owner-1", prompt: "x", seconds: 3, startImageKey: null, kind: "broll", sourceClipId: "clip-9", at: 4, status: "queued" };
    const { db, state } = fakeDb(job);
    state.sources.push(sourceClip);
    const { promise, lifecycle } = await run(job, db);
    await expect(promise).rejects.toThrow("does not fit");
    expect(lifecycle).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", step: null });
  });

  it("fails when the clip it was asked for was deleted", async () => {
    const job = { id: "job-d", ownerId: "owner-1", prompt: "x", seconds: 3, startImageKey: null, kind: "intro", sourceClipId: null, at: null, status: "queued" };
    const { db, state } = fakeDb(job);
    const { promise, lifecycle } = await run(job, db);
    await expect(promise).rejects.toThrow("was deleted");
    expect(lifecycle).toEqual([]);
    expect(state.job.status).toBe("failed");
  });

  it("makes no clip when an intro is cancelled while it is generated", async () => {
    const job = { id: "job-e", ownerId: "owner-1", prompt: "x", seconds: 3, startImageKey: null, kind: "intro", sourceClipId: "clip-9", at: null, status: "queued" };
    const { db, state } = fakeDb(job, "installed", (step, row) => {
      if (step === "Generating video 0%") Object.assign(row, { status: "failed", step: null, error: "Cancelled" });
    });
    state.sources.push(sourceClip);
    const { promise, lifecycle } = await run(job, db);
    await promise;
    expect(lifecycle).toEqual(["started", "stopped"]);
    expect(comfy.stops).toContain("/interrupt");
    expect(state.clips).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", error: "Cancelled" });
  });
});

describe("createAiClipVideo", () => {
  const queue = (sent: string[]) => ({ send: async (id: string) => (sent.push(id), "pg-boss-id") });

  it("saves an intro or B-roll request with its clip and moment, and queues it", async () => {
    const { db, state } = fakeDb({});
    state.sources.push(sourceClip);
    const sent: string[] = [];
    const base = { db, queue: queue(sent), ownerId: "owner-1", clipId: "clip-9", prompt: " A sunrise " };
    await createAiClipVideo({ ...base, kind: "intro", seconds: 5, at: null });
    await createAiClipVideo({ ...base, kind: "broll", seconds: 3, at: 3 });
    expect(state.created).toEqual([
      { ownerId: "owner-1", prompt: "A sunrise", seconds: 5, startImageKey: null, kind: "intro", sourceClipId: "clip-9", at: null },
      { ownerId: "owner-1", prompt: "A sunrise", seconds: 3, startImageKey: null, kind: "broll", sourceClipId: "clip-9", at: 3 },
    ]);
    expect(sent).toEqual(["new-job", "new-job"]);
  });

  it("refuses another owner's clip, a wrong length, a moment outside the clip, or a project still rendering", async () => {
    const { db, state } = fakeDb({});
    state.sources.push(sourceClip, { ...sourceClip, id: "short", length: 2 }, { ...sourceClip, id: "busy", project: { ownerId: "owner-1", status: "rendering" } });
    const intro = { db, queue: queue([]), ownerId: "owner-1", clipId: "clip-9", prompt: "A sunrise", kind: "intro" as const, seconds: 3, at: null };
    const broll = { ...intro, kind: "broll" as const, at: 1 };
    await expect(createAiClipVideo({ ...intro, ownerId: "owner-2" })).rejects.toThrow("clip not found");
    await expect(createAiClipVideo({ ...intro, prompt: " " })).rejects.toThrow("describe the video");
    await expect(createAiClipVideo({ ...intro, seconds: 4 })).rejects.toThrow("3 or 5 seconds");
    await expect(createAiClipVideo({ ...intro, at: 1 })).rejects.toThrow("first frame");
    await expect(createAiClipVideo({ ...broll, seconds: 5 })).rejects.toThrow("is 3 seconds");
    await expect(createAiClipVideo({ ...broll, at: null })).rejects.toThrow("pick the moment");
    await expect(createAiClipVideo({ ...broll, at: Number.NaN })).rejects.toThrow("pick the moment");
    await expect(createAiClipVideo({ ...broll, at: -0.5 })).rejects.toThrow("between 0 and 3.0 s");
    await expect(createAiClipVideo({ ...broll, at: 3.1 })).rejects.toThrow("between 0 and 3.0 s");
    await expect(createAiClipVideo({ ...broll, clipId: "short" })).rejects.toThrow("shorter than");
    await expect(createAiClipVideo({ ...intro, clipId: "busy" })).rejects.toThrow("rendering");
    const { db: noEngine, state: noEngineState } = fakeDb({}, "not_installed");
    noEngineState.sources.push(sourceClip);
    await expect(createAiClipVideo({ ...intro, db: noEngine })).rejects.toThrow("install the AI video engine first");
    expect(state.created).toEqual([]);
  });
});
