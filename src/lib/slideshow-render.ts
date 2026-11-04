import { randomInt, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { captionLines } from "@/clip-engine/captions-timing.js";
import { withCaptionBundle } from "@/clip-engine/render-captions.js";
import { mixBackgroundMusic } from "@/clip-engine/music.js";
import { buildVoiceTrack, preparePicture, renderSlideshow, slideTimings } from "@/clip-engine/slideshow.js";
import { captionOverlays } from "./clip-render";
import type { ClipStore } from "./clip-store";
import { requireEnv } from "./env";
import { drawPicture, type DrawPicture } from "./image-gen";
import { musicFile } from "./music-files";
import { startLlamaServer, writeScript, type StartLlm } from "./llm-script";
import { SLIDESHOW_PROJECT_NAME, sourceVideoDeleted } from "./slideshow";
import type { ReadySlide, Slide } from "./slideshow-options";
import { getSlideshowEngine, pictureMakerPaths, scriptWriterPaths, slideshowDir } from "./slideshow-engines";
import { buildClipKey } from "./storage";
import { kokoroSpeaker, type Speak } from "./voice";
import { transcribeWithWhisper } from "./whisper";

type Word = { text: string; startMs: number; endMs: number };

// What a slideshow runs on. The worker uses localSlideshowTools; tests put fakes in.
export type SlideshowTools = {
  startLlm: StartLlm;
  drawPicture: DrawPicture;
  speak: Speak;
  transcribe: (wav: string, workDir: string) => Promise<Word[]>;
  // The ffconcat list of the caption stills over a clip of total seconds.
  captions: (words: Word[], total: number, dir: string, preset: string) => Promise<string>;
};

const CAPTIONED = "slideshow";

// How often a running slideshow checks whether it was cancelled, to kill the llama-server or sd-cli it is waiting on.
const CANCEL_CHECK_MS = 2000;

// Thrown by a slideshow's write once it is cancelled, to stop it.
class SlideshowCancelled extends Error {}

// The installed engines, Kokoro from the installer's tools, and the whisper and caption path the clips use.
export function localSlideshowTools(db: PrismaClient): SlideshowTools {
  const root = slideshowDir();
  const script = scriptWriterPaths(root);
  const picture = pictureMakerPaths(root);
  return {
    startLlm: (signal) => startLlamaServer({ server: script.server, model: script.model, logPath: path.join(root, "llama-server.log"), signal }),
    drawPicture: (prompt, output, signal) => drawPicture({ models: picture, prompt, output, seed: randomInt(2 ** 31), signal }),
    speak: (lines, voice, dir) => kokoroSpeaker(requireEnv("KOKORO_MODEL"))(lines, voice, dir),
    transcribe: (wav, workDir) => transcribeWithWhisper(db, wav, workDir),
    captions: async (words, total, dir, preset) => {
      // Slideshows pick only the preset: the other caption options are not offered there and keep their defaults.
      const look = {
        captionPreset: preset,
        captionPosition: "bottom",
        captionUppercase: false,
        captionFont: "default",
        captionHighlight: "yellow",
        captionEmoji: false,
      };
      const clips = [{ clipId: CAPTIONED, start: 0, length: total }];
      const lists = await withCaptionBundle((serveUrl: string) => captionOverlays(captionLines(words), clips, dir, look, serveUrl));
      return lists.get(CAPTIONED)!;
    },
  };
}

// The owner's "Slideshows" project, made the first time it is needed. The worker makes one slideshow at a time, so two
// jobs cannot both create it.
async function slideshowProject(db: PrismaClient, ownerId: string, captionPreset: string) {
  const existing = await db.clipProject.findFirst({ where: { ownerId, slideshows: true } });
  if (existing) return existing;
  return db.clipProject.create({
    data: { ownerId, name: SLIDESHOW_PROJECT_NAME, slideshows: true, status: "done", withCaptions: true, captionPreset },
  });
}

// Runs one step of a slideshow: "script" writes its slides into a draft for the person to edit; "render" makes the
// edited draft into a clip in the owner's "Slideshows" project. Cancelling it marks it failed: its writes stop landing,
// it stops at the next step, and the llama-server or sd-cli it is waiting on is killed within checkEveryMs.
export async function runSlideshowJob({
  db,
  store,
  jobId,
  kind,
  workDir,
  tools,
  checkEveryMs = CANCEL_CHECK_MS,
}: {
  db: PrismaClient;
  store: ClipStore;
  jobId: string;
  kind: "script" | "render";
  workDir: string;
  tools: SlideshowTools;
  checkEveryMs?: number;
}) {
  const job = await db.slideshowJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`slideshow ${jobId} not found`);
  // Cancelled before the worker took it.
  if (job.status === "failed") return;
  if (kind === "script" && job.status !== "writing") throw new Error(`slideshow ${jobId} is not waiting for its script`);
  if (kind === "render" && job.status !== "queued") throw new Error(`slideshow ${jobId} is not waiting to be made`);

  // The state it has while this step runs; anything else means it was cancelled.
  const active = kind === "script" ? ("writing" as const) : ("running" as const);
  const write = async (data: Prisma.SlideshowJobUncheckedUpdateManyInput) => {
    const { count } = await db.slideshowJob.updateMany({ where: { id: jobId, status: active }, data });
    if (count === 0) throw new SlideshowCancelled();
  };
  const step = (text: string) => write({ step: text });

  const controller = new AbortController();
  const { signal } = controller;
  const check = setInterval(() => {
    db.slideshowJob.findUnique({ where: { id: jobId }, select: { status: true } }).then(
      (row) => {
        if (row?.status !== active) controller.abort(new SlideshowCancelled());
      },
      (err: unknown) => controller.abort(err),
    );
  }, checkEveryMs);

  try {
    if (kind === "render") {
      const { count } = await db.slideshowJob.updateMany({
        where: { id: jobId, status: "queued" },
        data: { status: "running", step: "Getting the pictures", error: null },
      });
      if (count === 0) throw new SlideshowCancelled();
    }
    if (kind === "script") {
      await step("Writing script");
      if ((await getSlideshowEngine(db, "script")).status !== "installed") throw new Error("the script writer is not installed");
      const script = await writeScript({ start: tools.startLlm, topic: job.topic, count: job.slideCount, signal });
      const slides: Slide[] = script.map((slide) => ({ ...slide, source: null }));
      await write({ slides, status: "draft", step: null, error: null });
      return;
    }

    const slides = job.slides as ReadySlide[];
    const total = slides.length;
    const anyAi = slides.some((slide) => slide.source.kind === "ai");
    if (anyAi && (await getSlideshowEngine(db, "picture")).status !== "installed") throw new Error("the picture maker is not installed");

    // A clip or video used for several slides is downloaded once.
    const downloads = new Map<string, string>();
    const fetchFile = async (key: string) => {
      const cached = downloads.get(key);
      if (cached) return cached;
      const file = path.join(workDir, `source-${downloads.size}${path.extname(key)}`);
      await store.downloadTo(key, file);
      downloads.set(key, file);
      return file;
    };
    const pictures: string[] = [];
    for (const [index, slide] of slides.entries()) {
      const picture = path.join(workDir, `picture-${index}.png`);
      const { source } = slide;
      if (source.kind === "ai") {
        await step(`Drawing picture ${index + 1} of ${total}`);
        const drawn = path.join(workDir, `drawn-${index}.png`);
        await tools.drawPicture(slide.picture, drawn, signal);
        await preparePicture({ input: drawn, output: picture });
      } else {
        await step(`Getting picture ${index + 1} of ${total}`);
        if (source.kind === "photo") {
          await preparePicture({ input: await fetchFile(source.key), output: picture });
        } else if (source.kind === "clip") {
          const clip = await db.clip.findUnique({ where: { id: source.clipId }, select: { storageKey: true } });
          if (!clip) throw new Error(`the clip picked for slide ${index + 1} no longer exists`);
          await preparePicture({ input: await fetchFile(clip.storageKey), output: picture, at: source.at });
        } else {
          const project = await db.clipProject.findUnique({ where: { id: source.projectId }, select: { sourceKey: true, sourceDeletedAt: true } });
          if (project?.sourceDeletedAt) throw new Error(sourceVideoDeleted(index));
          if (!project?.sourceKey) throw new Error(`the video picked for slide ${index + 1} no longer exists`);
          await preparePicture({ input: await fetchFile(project.sourceKey), output: picture, at: source.at });
        }
      }
      pictures.push(picture);
    }

    await step("Voice");
    const voiceDir = path.join(workDir, "voice");
    await mkdir(voiceDir, { recursive: true });
    const spoken = await tools.speak(
      slides.map((slide) => slide.text),
      job.voice,
      voiceDir,
    );
    const timings = slideTimings(spoken.map((line) => line.seconds));
    const voice = path.join(workDir, "voice.wav");
    await buildVoiceTrack({ lines: spoken.map((line) => line.file), timings, output: voice });

    await step("Captions");
    const words = await tools.transcribe(voice, workDir);
    const captionDir = path.join(workDir, "captions");
    await mkdir(captionDir, { recursive: true });
    const overlay = await tools.captions(words, timings.total, captionDir, job.captionPreset);

    await step("Putting it together");
    const output = path.join(workDir, "slideshow.mp4");
    await renderSlideshow({ pictures, voice, timings, overlay, output });
    const finished = job.musicTrack ? path.join(workDir, "slideshow-music.mp4") : output;
    if (job.musicTrack) {
      await step("Adding the music");
      await mixBackgroundMusic({ input: output, music: musicFile(job.musicTrack), volume: job.musicVolume, output: finished });
    }

    await step("Adding the clip");
    const project = await slideshowProject(db, job.ownerId, job.captionPreset);
    const clipId = randomUUID();
    const storageKey = buildClipKey(project.id, clipId);
    await store.upload(storageKey, finished, "video/mp4");
    const count = await db.clip.count({ where: { projectId: project.id } });
    await db.clip.create({
      data: {
        id: clipId,
        projectId: project.id,
        name: `slideshow-${String(count + 1).padStart(3, "0")}`,
        start: 0,
        length: Math.max(1, Math.round(timings.total)),
        storageKey,
        aiGenerated: anyAi,
        musicTrack: job.musicTrack,
      },
    });
    await write({ status: "done", step: null, clipId });
  } catch (err) {
    // A killed llama-server or sd-cli fails its step; the cancel is what stopped it.
    if (err instanceof SlideshowCancelled || signal.reason instanceof SlideshowCancelled) return;
    const failure = signal.aborted ? signal.reason : err;
    const message = failure instanceof Error ? failure.message : String(failure);
    const { count } = await db.slideshowJob.updateMany({ where: { id: jobId, status: active }, data: { status: "failed", step: null, error: message } });
    // Cancelled while it failed: the cancel already recorded it.
    if (count === 0) return;
    throw failure;
  } finally {
    clearInterval(check);
  }
}
