import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { overlayList, renderBlankOverlay } from "@/clip-engine/ffmpeg.js";
import type { ClipStore } from "./clip-store";
import { writeFakeEngines } from "./fake-slideshow-engines";
import { drawPicture } from "./image-gen";
import { startLlamaServer } from "./llm-script";
import { runSlideshowJob, type SlideshowTools } from "./slideshow-render";

type Row = Record<string, unknown>;

function fakeDb(job: Row, engines: Record<string, string> = { script: "installed", picture: "installed" }) {
  const state = { job: { ...job }, steps: [] as string[], projects: [] as Row[], clips: [] as Row[] };
  const db = {
    slideshowEngine: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: engines[where.id] }) },
    slideshowJob: {
      findUnique: async () => ({ ...state.job }),
      update: async ({ data }: { data: Row }) => {
        if (typeof data.step === "string") state.steps.push(data.step);
        Object.assign(state.job, data);
        return state.job;
      },
    },
    clip: {
      findUnique: async ({ where }: { where: Row }) => (where.id === "clip-1" ? { storageKey: "clips/p/clip-1.mp4" } : null),
      count: async ({ where }: { where: Row }) => state.clips.filter((clip) => clip.projectId === where.projectId).length,
      create: async ({ data }: { data: Row }) => {
        state.clips.push(data);
        return data;
      },
    },
    clipProject: {
      findUnique: async ({ where }: { where: Row }) => (where.id === "project-video" ? { sourceKey: "clip-sources/project-video.mp4" } : null),
      findFirst: async ({ where }: { where: Row }) => state.projects.find((p) => p.ownerId === where.ownerId && p.slideshows) ?? null,
      create: async ({ data }: { data: Row }) => {
        const project = { id: `project-${state.projects.length + 1}`, ...data };
        state.projects.push(project);
        return project;
      },
    },
  };
  return { db: db as unknown as PrismaClient, state };
}

let root: string;
let bucket: string;
let fakes: { server: string; cli: string };
let llamaRecord: string;
let sdRecord: string;
const spoken: { lines: string[]; voice: string }[] = [];
const captioned: { words: number; total: number; preset: string }[] = [];

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

// The fake engines through the real start, request and drawing code; a sine for each voice line (0.1 s per word);
// one caption still over the whole show.
function tools(): SlideshowTools {
  const models = { cli: fakes.cli, diffusion: "/m/z_image_turbo-Q4_K.gguf", llm: "/m/Qwen3-4B.gguf", vae: "/m/ae.safetensors" };
  return {
    startLlm: () => startLlamaServer({ server: fakes.server, model: "/m/Qwen3.5-4B-Q4_K_M.gguf", logPath: path.join(root, "llama-server.log") }),
    drawPicture: (prompt, output) => drawPicture({ models, prompt, output, seed: 7 }),
    speak: async (lines, voice, dir) => {
      spoken.push({ lines, voice });
      return lines.map((line, index) => {
        const file = path.join(dir, `line-${index}.wav`);
        const seconds = line.split(" ").length / 10;
        execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-ar", "24000", "-ac", "1", file]);
        return { file, seconds };
      });
    },
    transcribe: async () => [{ text: "Hello", startMs: 0, endMs: 400 }],
    captions: async (words, total, dir, preset) => {
      captioned.push({ words: words.length, total, preset });
      const blank = path.join(dir, "blank.png");
      await renderBlankOverlay(blank);
      const still = path.join(dir, "still.png");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white@0.5:s=1080x1920,format=rgba", "-frames:v", "1", still]);
      const list = path.join(dir, "captions.ffconcat");
      await writeFile(list, overlayList({ overlays: [{ image: still, start: 0, end: 0.4 }], blank, length: total }));
      return list;
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "slideshow-render-test-"));
  fakes = await writeFakeEngines(root);
  llamaRecord = path.join(root, "llama.jsonl");
  sdRecord = path.join(root, "sd.jsonl");
  process.env.FAKE_LLAMA_RECORD = llamaRecord;
  process.env.FAKE_SD_RECORD = sdRecord;
  process.env.FAKE_SD_PICTURE = path.join(root, "drawn.png");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=orange:s=768x1344", "-frames:v", "1", process.env.FAKE_SD_PICTURE]);

  bucket = path.join(root, "bucket");
  for (const folder of ["clips/p", "clip-sources", "slideshow-inputs"]) await mkdir(path.join(bucket, folder), { recursive: true });
  const video = (file: string, size: string) =>
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30`, "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  video(path.join(bucket, "clips/p/clip-1.mp4"), "1080x1920");
  video(path.join(bucket, "clip-sources/project-video.mp4"), "1280x720");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=purple:s=640x480", "-frames:v", "1", path.join(bucket, "slideshow-inputs/0b0e5e5e-1111-4222-8333-944445555666.jpg")]);
});

afterAll(async () => {
  for (const name of ["FAKE_LLAMA_RECORD", "FAKE_SD_RECORD", "FAKE_SD_PICTURE"]) delete process.env[name];
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeFile(llamaRecord, "");
  await writeFile(sdRecord, "");
  spoken.length = 0;
  captioned.length = 0;
});

async function run(job: Row, kind: "script" | "render", db: PrismaClient) {
  const workDir = await mkdtemp(path.join(root, "work-"));
  return runSlideshowJob({ db, store: bucketStore(), jobId: String(job.id), kind, workDir, tools: tools() });
}

const records = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe("runSlideshowJob: script", () => {
  it("writes the slides into a draft with llama-server, then stops it", async () => {
    const job = { id: "show-1", ownerId: "owner-1", topic: "Better sleep", slideCount: 3, status: "writing", slides: null };
    const { db, state } = fakeDb(job);
    await run(job, "script", db);

    expect(state.steps).toEqual(["Writing script"]);
    expect(state.job).toMatchObject({
      status: "draft",
      step: null,
      slides: [
        { text: "Line 1.", picture: "Picture 1", source: null },
        { text: "Line 2.", picture: "Picture 2", source: null },
        { text: "Line 3.", picture: "Picture 3", source: null },
      ],
    });
    const [asked, stopped] = await records(llamaRecord);
    expect(asked.request.messages[1].content).toContain("about: Better sleep");
    expect(stopped).toEqual({ stopped: true });
  });

  it("fails without starting llama-server when the script writer is not installed", async () => {
    const job = { id: "show-2", ownerId: "owner-1", topic: "x", slideCount: 3, status: "writing", slides: null };
    const { db, state } = fakeDb(job, { script: "not_installed", picture: "installed" });
    await expect(run(job, "script", db)).rejects.toThrow("script writer is not installed");
    expect(await records(llamaRecord)).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", error: "the script writer is not installed" });
  });
});

describe("runSlideshowJob: render", () => {
  const slides = [
    { text: "Sleep is a skill you can learn.", picture: "A calm bedroom at dusk, soft light", source: { kind: "ai" } },
    { text: "Keep the room cool and dark.", picture: "A dark room", source: { kind: "clip", clipId: "clip-1", at: 1.5 } },
    { text: "Put the phone away an hour before bed.", picture: "A phone", source: { kind: "photo", key: "slideshow-inputs/0b0e5e5e-1111-4222-8333-944445555666.jpg" } },
    { text: "Then wake up at the same time.", picture: "Sunrise", source: { kind: "video", projectId: "project-video", at: 2 } },
  ];

  it("draws the AI picture with sd, takes the others from clips, videos and photos, and adds an AI-marked clip", async () => {
    const job = { id: "show-3", ownerId: "owner-1", topic: "Better sleep", slideCount: 4, status: "queued", slides, voice: "bf_emma", captionPreset: "words" };
    const { db, state } = fakeDb(job);
    await run(job, "render", db);

    expect(state.steps).toEqual([
      "Getting the pictures",
      "Drawing picture 1 of 4",
      "Getting picture 2 of 4",
      "Getting picture 3 of 4",
      "Getting picture 4 of 4",
      "Voice",
      "Captions",
      "Putting it together",
      "Adding the clip",
    ]);
    const [args] = await records(sdRecord);
    expect(args).toEqual(
      expect.arrayContaining(["-p", "A calm bedroom at dusk, soft light", "-W", "768", "-H", "1344", "--steps", "8", "--cfg-scale", "1.0", "--llm", "/m/Qwen3-4B.gguf"]),
    );
    expect(spoken).toEqual([{ lines: slides.map((slide) => slide.text), voice: "bf_emma" }]);
    // 7, 6, 8 and 7 words at 0.1 s each, plus 0.3 s per slide.
    expect(captioned).toEqual([{ words: 1, total: 4, preset: "words" }]);

    expect(state.projects).toEqual([
      { id: "project-1", ownerId: "owner-1", name: "Slideshows", slideshows: true, status: "done", withCaptions: true, captionPreset: "words" },
    ]);
    expect(state.clips).toHaveLength(1);
    const clip = state.clips[0];
    expect(clip).toMatchObject({ projectId: "project-1", name: "slideshow-001", start: 0, length: 4, aiGenerated: true });
    expect(state.job).toMatchObject({ status: "done", step: null, clipId: clip.id });

    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path.join(bucket, String(clip.storageKey))], {
        encoding: "utf8",
      }),
    ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
    expect(probe.streams.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
    expect(probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ width: 1080, height: 1920 });
    expect(Number(probe.format.duration)).toBeCloseTo(4, 1);
  });

  it("makes a clip without the AI label from the person's own pictures, without the picture maker", async () => {
    const own = slides.slice(1);
    const job = { id: "show-4", ownerId: "owner-1", topic: "Own", slideCount: 3, status: "queued", slides: own, voice: "af_heart", captionPreset: "classic" };
    const { db, state } = fakeDb(job, { script: "installed", picture: "not_installed" });
    state.projects.push({ id: "existing", ownerId: "owner-1", slideshows: true });
    state.clips.push({ projectId: "existing" });
    await run(job, "render", db);
    expect(await records(sdRecord)).toEqual([]);
    expect(state.clips[1]).toMatchObject({ projectId: "existing", name: "slideshow-002", aiGenerated: false });
  });

  it("records the picture maker's error and makes no clip", async () => {
    const failing = [{ ...slides[0], picture: "out of memory please" }, ...slides.slice(1, 3)];
    const job = { id: "show-5", ownerId: "owner-1", topic: "x", slideCount: 3, status: "queued", slides: failing, voice: "af_heart", captionPreset: "words" };
    const { db, state } = fakeDb(job);
    await expect(run(job, "render", db)).rejects.toThrow("the picture maker exited with 1");
    expect(state.clips).toEqual([]);
    expect(state.job).toMatchObject({ status: "failed", step: null, error: expect.stringContaining("Device memory allocation") });
  });

  it("fails before drawing when an AI slide needs the picture maker and it is not installed", async () => {
    const job = { id: "show-6", ownerId: "owner-1", topic: "x", slideCount: 4, status: "queued", slides, voice: "af_heart", captionPreset: "words" };
    const { db, state } = fakeDb(job, { script: "installed", picture: "not_installed" });
    await expect(run(job, "render", db)).rejects.toThrow("picture maker is not installed");
    expect(await records(sdRecord)).toEqual([]);
    expect(state.job.status).toBe("failed");
  });
});
