import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { extractFrame, joinIntro, overlayBroll, probeClip } from "@/clip-engine/ai-clip.js";
import { convertAiVideo } from "@/clip-engine/ffmpeg.js";
import { CLIP_NAME_MAX, UPLOAD_TITLE_MAX } from "@/clip-engine/helpers.js";
import { AI_CLIP_LABELS, BROLL_SECONDS, INTRO_SECONDS, type AiClipKind } from "./ai-clip-options";
import { getAiEngine } from "./ai-engine";
import { AI_VIDEO_SECONDS, fillWorkflow, OUTPUT_NODE, SAMPLER_NODE } from "./ai-workflow";
import type { ClipStore } from "./clip-store";
import { downloadOutput, interruptComfy, runWorkflow, uploadImage, type StartComfy } from "./comfy";
import { buildAiInputKey, buildClipKey } from "./storage";
import { UserError } from "./user-error";

export const MAX_PROMPT_LENGTH = 2000;
export const AI_PROJECT_NAME = "AI videos";

export const START_IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export type AiVideoQueue = { send(jobId: string): Promise<string> };

// What a cancelled AI video says on the Clips page.
export const AI_VIDEO_CANCELLED = "Cancelled";

// Where the browser uploads a start picture before the video is asked for.
export function startImageUpload(extension: string) {
  const ext = extension.toLowerCase();
  const contentType = START_IMAGE_TYPES[ext];
  if (!contentType) throw new UserError(`the start picture must be PNG, JPEG or WebP, not "${ext}"`);
  return { key: buildAiInputKey(randomUUID(), ext), contentType };
}

const START_IMAGE_KEY = /^ai-inputs\/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/;

export async function createAiVideo({
  db,
  queue,
  ownerId,
  prompt,
  seconds,
  startImageKey,
}: {
  db: PrismaClient;
  queue: AiVideoQueue;
  ownerId: string;
  prompt: string;
  seconds: number;
  startImageKey: string | null;
}) {
  const text = checkPrompt(prompt);
  if (!(AI_VIDEO_SECONDS as readonly number[]).includes(seconds)) {
    throw new UserError(`the length must be ${AI_VIDEO_SECONDS.join(", ")} seconds`);
  }
  if (startImageKey !== null && !START_IMAGE_KEY.test(startImageKey)) throw new UserError("the start picture upload is not valid");
  if ((await getAiEngine(db)).status !== "installed") throw new UserError("install the AI video engine first");

  return queueJob(db, queue, { ownerId, prompt: text, seconds, startImageKey });
}

function checkPrompt(prompt: string): string {
  const text = prompt.trim();
  if (!text) throw new UserError("describe the video you want");
  if (text.length > MAX_PROMPT_LENGTH) throw new UserError(`the description can be at most ${MAX_PROMPT_LENGTH} characters`);
  return text;
}

async function queueJob(
  db: PrismaClient,
  queue: AiVideoQueue,
  data: { ownerId: string; prompt: string; seconds: number; startImageKey: string | null; kind?: AiClipKind; sourceClipId?: string; at?: number | null },
) {
  const job = await db.aiVideoJob.create({ data });
  try {
    await queue.send(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.aiVideoJob.update({ where: { id: job.id }, data: { status: "failed", error: message } });
    throw err;
  }
  return job;
}

// An AI intro (seconds long, before the clip) or a B-roll shot (over the clip's picture from `at`) made from one of the
// owner's clips. The result is a new clip next to it; the clip itself is not changed.
export async function createAiClipVideo({
  db,
  queue,
  ownerId,
  clipId,
  kind,
  prompt,
  seconds,
  at,
}: {
  db: PrismaClient;
  queue: AiVideoQueue;
  ownerId: string;
  clipId: string;
  kind: AiClipKind;
  prompt: string;
  seconds: number;
  at: number | null;
}) {
  const text = checkPrompt(prompt);
  const clip = await db.clip.findFirst({ where: { id: clipId, project: { ownerId } }, include: { project: { select: { status: true } } } });
  if (!clip) throw new UserError("clip not found");
  if (clip.project.status === "rendering" || clip.project.status === "picking") throw new UserError("clips are rendering for this project");
  if (kind === "intro") {
    if (!(INTRO_SECONDS as readonly number[]).includes(seconds)) throw new UserError(`the intro must be ${INTRO_SECONDS.join(" or ")} seconds`);
    if (at !== null) throw new UserError("an intro starts from the clip's first frame, not a chosen moment");
  } else {
    if (seconds !== BROLL_SECONDS) throw new UserError(`the B-roll shot is ${BROLL_SECONDS} seconds`);
    if (at === null || !Number.isFinite(at)) throw new UserError("pick the moment the B-roll covers");
    const latest = clip.length - BROLL_SECONDS;
    if (latest < 0) throw new UserError(`the clip is shorter than the ${BROLL_SECONDS} s B-roll shot`);
    if (at < 0 || at > latest) throw new UserError(`the moment must be between 0 and ${latest.toFixed(1)} s, so the shot ends in the clip`);
  }
  if ((await getAiEngine(db)).status !== "installed") throw new UserError("install the AI video engine first");

  return queueJob(db, queue, { ownerId, prompt: text, seconds, startImageKey: null, kind, sourceClipId: clip.id, at });
}

// The owner's "AI videos" project, made the first time it is needed. The worker makes one video at a time, so two
// jobs cannot both create it.
async function aiProject(db: PrismaClient, ownerId: string) {
  const existing = await db.clipProject.findFirst({ where: { ownerId, aiVideos: true } });
  if (existing) return existing;
  return db.clipProject.create({ data: { ownerId, name: AI_PROJECT_NAME, aiVideos: true, status: "done" } });
}

// Makes one AI video: starts ComfyUI, runs the Wan 2.2 workflow, stops ComfyUI, converts the result for Instagram and
// adds it as a clip to the owner's "AI videos" project.
export async function runAiVideoJob({
  db,
  store,
  jobId,
  workDir,
  startComfy,
}: {
  db: PrismaClient;
  store: ClipStore;
  jobId: string;
  workDir: string;
  startComfy: StartComfy;
}) {
  const job = await db.aiVideoJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`AI video job ${jobId} not found`);
  // Cancelling marks the job failed, so writes only land while it is still running, and it stops at the next check.
  const running = { id: jobId, status: "running" as const };
  // Whether the step was written, which it is not once the video is cancelled.
  const step = async (text: string) => (await db.aiVideoJob.updateMany({ where: running, data: { step: text } })).count > 0;
  const stillRunning = async () => {
    if ((await db.aiVideoJob.findUnique({ where: { id: jobId } }))?.status !== "running") throw new Error(`AI video job ${jobId} was cancelled`);
  };

  try {
    const fromClip = job.kind !== "prompt";
    const started = await db.aiVideoJob.updateMany({
      where: { id: jobId, status: "queued" },
      data: { status: "running", step: fromClip ? "Taking the start picture" : "Starting the AI engine", error: null },
    });
    // Cancelled between pg-boss handing it out and here.
    if (started.count === 0) return;
    if ((await getAiEngine(db)).status !== "installed") throw new Error("the AI video engine is not installed");

    // An intro or B-roll starts from the clip's frame at its moment.
    const source = fromClip ? await sourceClip(db, store, job, workDir) : null;
    if (source) await step("Starting the AI engine");

    const generated = path.join(workDir, "generated.mp4");
    const comfy = await startComfy();
    // Progress is written one step at a time, and the last write lands before anything after it.
    let writing: Promise<unknown> = Promise.resolve();
    try {
      await stillRunning();
      let startImage: string | null = null;
      if (source) {
        startImage = await uploadImage(comfy.url, source.frame);
      } else if (job.startImageKey) {
        const picture = path.join(workDir, `start${path.extname(job.startImageKey)}`);
        await store.downloadTo(job.startImageKey, picture);
        startImage = await uploadImage(comfy.url, picture);
      }
      await step("Generating video 0%");
      // A write per whole percent at most.
      let shown = 0;
      const outputs = await runWorkflow({
        url: comfy.url,
        workflow: fillWorkflow({ prompt: job.prompt, seconds: job.seconds, startImage, seed: randomInt(2 ** 47) }),
        progressNode: SAMPLER_NODE,
        outputNode: OUTPUT_NODE,
        onProgress: (fraction) => {
          const percent = Math.floor(fraction * 100);
          if (percent <= shown) return;
          shown = percent;
          // Cancelled after the check above, while ComfyUI was being handed the workflow: the worker stops it itself.
          writing = writing.then(async () => {
            if (!(await step(`Generating video ${percent}%`))) await interruptComfy(comfy.url);
          });
        },
      });
      await writing;
      await stillRunning();
      await step("Saving the video");
      await downloadOutput(comfy.url, outputs[0], generated);
    } finally {
      await writing;
      await comfy.stop();
    }

    if (source) {
      await addToClip({ db, store, jobId, step, stillRunning, source, generated, workDir });
      return;
    }

    await step("Converting for Instagram");
    const converted = path.join(workDir, "converted.mp4");
    await convertAiVideo({ input: generated, output: converted });

    await stillRunning();
    await step("Adding the clip");
    const project = await aiProject(db, job.ownerId);
    const clipId = randomUUID();
    const storageKey = buildClipKey(project.id, clipId);
    await store.upload(storageKey, converted, "video/mp4");
    const count = await db.clip.count({ where: { projectId: project.id } });
    await db.clip.create({
      data: {
        id: clipId,
        projectId: project.id,
        name: `ai-${String(count + 1).padStart(3, "0")}`,
        start: 0,
        length: job.seconds,
        storageKey,
        aiGenerated: true,
      },
    });
    await db.aiVideoJob.updateMany({ where: running, data: { status: "done", step: null, clipId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { count } = await db.aiVideoJob.updateMany({ where: running, data: { status: "failed", step: null, error: message } });
    // A cancelled video stops here: the cancel already recorded it.
    if (count === 0) return;
    throw err;
  }
}

type SourceClip = {
  clip: { id: string; projectId: string; name: string; title: string | null; description: string | null; musicTrack: string | null; start: number };
  kind: AiClipKind;
  file: string;
  frame: string;
  at: number;
  seconds: number;
};

// The clip an intro or B-roll is made from, downloaded, with the frame its shot starts from.
async function sourceClip(
  db: PrismaClient,
  store: ClipStore,
  job: { kind: "intro" | "broll" | "prompt"; sourceClipId: string | null; at: number | null; seconds: number },
  workDir: string,
): Promise<SourceClip> {
  if (job.kind === "prompt") throw new Error("a prompt video has no source clip");
  if (!job.sourceClipId) throw new Error("the clip this was asked for was deleted");
  const clip = await db.clip.findUnique({ where: { id: job.sourceClipId } });
  if (!clip) throw new Error(`clip ${job.sourceClipId} not found`);
  const file = path.join(workDir, "source.mp4");
  await store.downloadTo(clip.storageKey, file);
  const { duration } = await probeClip(file);
  let at = 0;
  if (job.kind === "broll") {
    if (job.at === null) throw new Error("a B-roll job has no moment");
    if (job.at < 0 || job.at + job.seconds > duration) throw new Error(`the moment ${job.at}s does not fit the ${duration}s clip`);
    at = job.at;
  }
  const frame = path.join(workDir, "start.png");
  await extractFrame({ input: file, at, output: frame });
  return { clip, kind: job.kind, file, frame, at, seconds: job.seconds };
}

// Joins the AI shot to the source clip and adds the result as a new clip in its project.
async function addToClip({
  db,
  store,
  jobId,
  step,
  stillRunning,
  source,
  generated,
  workDir,
}: {
  db: PrismaClient;
  store: ClipStore;
  jobId: string;
  step: (text: string) => Promise<boolean>;
  stillRunning: () => Promise<void>;
  source: SourceClip;
  generated: string;
  workDir: string;
}) {
  const output = path.join(workDir, "joined.mp4");
  if (source.kind === "intro") {
    await step("Joining the intro to the clip");
    await joinIntro({ intro: generated, seconds: source.seconds, clip: source.file, output });
  } else {
    await step("Laying the B-roll over the clip");
    await overlayBroll({ clip: source.file, shot: generated, at: source.at, seconds: source.seconds, output });
  }
  const { duration } = await probeClip(output);

  await stillRunning();
  await step("Adding the clip");
  const { clip } = source;
  // The clip's name and title are shortened so the results still fit their limits.
  const suffix = ` + ${AI_CLIP_LABELS[source.kind]}`;
  const clipId = randomUUID();
  const storageKey = buildClipKey(clip.projectId, clipId);
  await store.upload(storageKey, output, "video/mp4");
  await db.clip.create({
    data: {
      id: clipId,
      projectId: clip.projectId,
      name: `${clip.name.slice(0, CLIP_NAME_MAX - suffix.length)}${suffix}`,
      start: clip.start,
      length: duration,
      storageKey,
      title: `${(clip.title || clip.name).slice(0, UPLOAD_TITLE_MAX - suffix.length)}${suffix}`,
      description: clip.description,
      musicTrack: clip.musicTrack,
      aiGenerated: true,
    },
  });
  await db.aiVideoJob.updateMany({ where: { id: jobId, status: "running" }, data: { status: "done", step: null, clipId } });
}
