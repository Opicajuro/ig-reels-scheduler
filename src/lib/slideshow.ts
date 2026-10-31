import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { CAPTION_PRESET_NAMES } from "@/clip-engine/remotion/caption-presets.js";
import { checkSlideCount } from "./llm-script";
import { isVoicePreset, MAX_LINE_LENGTH, MAX_PICTURE_LENGTH, MAX_TOPIC_LENGTH, type ReadySlide } from "./slideshow-options";
import { getSlideshowEngine } from "./slideshow-engines";
import { buildSlideshowInputKey } from "./storage";
import { UserError } from "./user-error";

// Slideshows asked for on the Clips page: the script request and, once the person has edited it, the render request.
// The worker does the work (slideshow-render.ts).

export const SLIDESHOW_PROJECT_NAME = "Slideshows";

export type SlideshowQueue = { send(jobId: string, kind: "script" | "render"): Promise<string> };

export const PHOTO_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const PHOTO_KEY = /^slideshow-inputs\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/;

// Where the browser uploads a slide's photo before the slideshow is made.
export function slideshowPhotoUpload(extension: string) {
  const ext = extension.toLowerCase();
  const contentType = PHOTO_TYPES[ext];
  if (!contentType) throw new UserError(`the photo must be PNG, JPEG or WebP, not "${ext}"`);
  return { key: buildSlideshowInputKey(randomUUID(), ext), contentType };
}

async function queueOrFail(db: PrismaClient, jobId: string, send: () => Promise<string>) {
  try {
    await send();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.slideshowJob.update({ where: { id: jobId }, data: { status: "failed", step: null, error: message } });
    throw err;
  }
}

// Saves the topic and queues the script writer.
export async function createSlideshowScript({
  db,
  queue,
  ownerId,
  topic,
  slideCount,
}: {
  db: PrismaClient;
  queue: SlideshowQueue;
  ownerId: string;
  topic: string;
  slideCount: number;
}) {
  const text = topic.trim();
  if (!text) throw new UserError("type what the slideshow is about");
  if (text.length > MAX_TOPIC_LENGTH) throw new UserError(`the topic can be at most ${MAX_TOPIC_LENGTH} characters`);
  checkSlideCount(slideCount);
  if ((await getSlideshowEngine(db, "script")).status !== "installed") throw new UserError("install the script writer first");

  const job = await db.slideshowJob.create({ data: { ownerId, topic: text, slideCount, status: "writing", step: "Waiting for the worker" } });
  await queueOrFail(db, job.id, () => queue.send(job.id, "script"));
  return job;
}

function checkText(value: unknown, what: string, max: number, index: number): string {
  if (typeof value !== "string" || !value.trim()) throw new UserError(`slide ${index + 1} needs its ${what}`);
  const text = value.trim();
  if (text.length > max) throw new UserError(`the ${what} of slide ${index + 1} can be at most ${max} characters`);
  return text;
}

function checkTime(value: unknown, length: number, index: number): number {
  const at = Number(value);
  if (!Number.isFinite(at) || at < 0 || at > length) throw new UserError(`the moment picked for slide ${index + 1} is outside the video`);
  return at;
}

// The slides as the editor sends them, checked: every line and description is there, and every picture source is
// the owner's own clip, video or uploaded photo, or the picture maker, which must then be installed.
export async function checkSlides(db: PrismaClient, ownerId: string, input: unknown, count: number): Promise<ReadySlide[]> {
  if (!Array.isArray(input) || input.length !== count) throw new UserError(`the slideshow needs its ${count} slides`);
  const slides: ReadySlide[] = [];
  for (const [index, raw] of input.entries()) {
    const slide = (raw ?? {}) as Record<string, unknown>;
    const text = checkText(slide.text, "line", MAX_LINE_LENGTH, index);
    const picture = checkText(slide.picture, "picture description", MAX_PICTURE_LENGTH, index);
    const source = (slide.source ?? null) as Record<string, unknown> | null;
    if (!source) throw new UserError(`choose a picture for slide ${index + 1}`);
    if (source.kind === "ai") {
      slides.push({ text, picture, source: { kind: "ai" } });
    } else if (source.kind === "clip") {
      const clip = await db.clip.findFirst({ where: { id: String(source.clipId), project: { ownerId } }, select: { id: true, length: true } });
      if (!clip) throw new UserError(`the clip picked for slide ${index + 1} no longer exists`);
      slides.push({ text, picture, source: { kind: "clip", clipId: clip.id, at: checkTime(source.at, clip.length, index) } });
    } else if (source.kind === "video") {
      const project = await db.clipProject.findFirst({
        where: { id: String(source.projectId), ownerId, sourceKey: { not: null } },
        select: { id: true, durationSeconds: true },
      });
      if (!project || project.durationSeconds === null) throw new UserError(`the video picked for slide ${index + 1} no longer exists`);
      slides.push({ text, picture, source: { kind: "video", projectId: project.id, at: checkTime(source.at, project.durationSeconds, index) } });
    } else if (source.kind === "photo") {
      if (typeof source.key !== "string" || !PHOTO_KEY.test(source.key)) throw new UserError(`the photo of slide ${index + 1} is not valid`);
      slides.push({ text, picture, source: { kind: "photo", key: source.key } });
    } else {
      throw new UserError(`choose a picture for slide ${index + 1}`);
    }
  }
  if (slides.some((slide) => slide.source.kind === "ai") && (await getSlideshowEngine(db, "picture")).status !== "installed") {
    throw new UserError("install the picture maker first, or choose your own pictures");
  }
  return slides;
}

// Saves the edited draft and queues it to be made. A failed slideshow can be made again the same way.
export async function startSlideshowRender({
  db,
  queue,
  ownerId,
  jobId,
  slides: input,
  voice,
  captionPreset,
}: {
  db: PrismaClient;
  queue: SlideshowQueue;
  ownerId: string;
  jobId: string;
  slides: unknown;
  voice: string;
  captionPreset: string;
}) {
  const job = await db.slideshowJob.findFirst({ where: { id: jobId, ownerId } });
  if (!job) throw new UserError("this slideshow no longer exists");
  if (!(job.status === "draft" || (job.status === "failed" && job.slides !== null))) {
    throw new UserError("this slideshow is not waiting to be made");
  }
  if (!isVoicePreset(voice)) throw new UserError("choose one of the voices");
  if (!(CAPTION_PRESET_NAMES as string[]).includes(captionPreset)) throw new UserError("choose one of the caption styles");
  const slides = await checkSlides(db, ownerId, input, job.slideCount);

  await db.slideshowJob.update({
    where: { id: jobId },
    data: { slides, voice, captionPreset, status: "queued", step: null, error: null },
  });
  await queueOrFail(db, jobId, () => queue.send(jobId, "render"));
}
