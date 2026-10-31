import { randomInt, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { captionLines } from "@/clip-engine/captions-timing.js";
import { buildVoiceTrack, preparePicture, renderSlideshow, slideTimings } from "@/clip-engine/slideshow.js";
import { transcribeToWords } from "@/clip-engine/transcribe.js";
import { captionOverlays } from "./clip-render";
import type { ClipStore } from "./clip-store";
import { requireEnv } from "./env";
import { drawPicture, type DrawPicture } from "./image-gen";
import { startLlamaServer, writeScript, type StartLlm } from "./llm-script";
import { SLIDESHOW_PROJECT_NAME } from "./slideshow";
import type { ReadySlide, Slide } from "./slideshow-options";
import { getSlideshowEngine, pictureMakerPaths, scriptWriterPaths, slideshowDir } from "./slideshow-engines";
import { buildClipKey } from "./storage";
import { kokoroSpeaker, type Speak } from "./voice";

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

// The installed engines, Kokoro from the installer's tools, and the whisper and caption path the clips use.
export function localSlideshowTools(): SlideshowTools {
  const root = slideshowDir();
  const script = scriptWriterPaths(root);
  const picture = pictureMakerPaths(root);
  return {
    startLlm: () => startLlamaServer({ server: script.server, model: script.model, logPath: path.join(root, "llama-server.log") }),
    drawPicture: (prompt, output) => drawPicture({ models: picture, prompt, output, seed: randomInt(2 ** 31) }),
    speak: (lines, voice, dir) => kokoroSpeaker(requireEnv("KOKORO_MODEL"))(lines, voice, dir),
    transcribe: (wav, workDir) =>
      transcribeToWords({ mediaPath: wav, workDir, whisperBin: requireEnv("WHISPER_BIN"), model: requireEnv("WHISPER_MODEL") }),
    captions: async (words, total, dir, preset) => {
      const lists = await captionOverlays(captionLines(words), [{ clipId: CAPTIONED, start: 0, length: total }], dir, {
        captionPreset: preset,
        captionPosition: "bottom",
        captionUppercase: false,
      });
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
// edited draft into a clip in the owner's "Slideshows" project.
export async function runSlideshowJob({
  db,
  store,
  jobId,
  kind,
  workDir,
  tools,
}: {
  db: PrismaClient;
  store: ClipStore;
  jobId: string;
  kind: "script" | "render";
  workDir: string;
  tools: SlideshowTools;
}) {
  const job = await db.slideshowJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`slideshow ${jobId} not found`);
  const step = (text: string) => db.slideshowJob.update({ where: { id: jobId }, data: { step: text } });

  try {
    if (kind === "script") {
      if (job.status !== "writing") throw new Error(`slideshow ${jobId} is not waiting for its script`);
      await step("Writing script");
      if ((await getSlideshowEngine(db, "script")).status !== "installed") throw new Error("the script writer is not installed");
      const script = await writeScript({ start: tools.startLlm, topic: job.topic, count: job.slideCount });
      const slides: Slide[] = script.map((slide) => ({ ...slide, source: null }));
      await db.slideshowJob.update({ where: { id: jobId }, data: { slides, status: "draft", step: null, error: null } });
      return;
    }

    if (job.status !== "queued") throw new Error(`slideshow ${jobId} is not waiting to be made`);
    const slides = job.slides as ReadySlide[];
    await db.slideshowJob.update({ where: { id: jobId }, data: { status: "running", step: "Getting the pictures", error: null } });
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
        await tools.drawPicture(slide.picture, drawn);
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
          const project = await db.clipProject.findUnique({ where: { id: source.projectId }, select: { sourceKey: true } });
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

    await step("Adding the clip");
    const project = await slideshowProject(db, job.ownerId, job.captionPreset);
    const clipId = randomUUID();
    const storageKey = buildClipKey(project.id, clipId);
    await store.upload(storageKey, output, "video/mp4");
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
      },
    });
    await db.slideshowJob.update({ where: { id: jobId }, data: { status: "done", step: null, clipId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.slideshowJob.update({ where: { id: jobId }, data: { status: "failed", step: null, error: message } });
    throw err;
  }
}
