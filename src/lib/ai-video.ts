import { randomInt, randomUUID } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { convertAiVideo } from "@/clip-engine/ffmpeg.js";
import { getAiEngine } from "./ai-engine";
import { AI_VIDEO_SECONDS, fillWorkflow, OUTPUT_NODE, SAMPLER_NODE } from "./ai-workflow";
import type { ClipStore } from "./clip-store";
import { downloadOutput, runWorkflow, uploadImage, type StartComfy } from "./comfy";
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
  const text = prompt.trim();
  if (!text) throw new UserError("describe the video you want");
  if (text.length > MAX_PROMPT_LENGTH) throw new UserError(`the description can be at most ${MAX_PROMPT_LENGTH} characters`);
  if (!(AI_VIDEO_SECONDS as readonly number[]).includes(seconds)) {
    throw new UserError(`the length must be ${AI_VIDEO_SECONDS.join(", ")} seconds`);
  }
  if (startImageKey !== null && !START_IMAGE_KEY.test(startImageKey)) throw new UserError("the start picture upload is not valid");
  if ((await getAiEngine(db)).status !== "installed") throw new UserError("install the AI video engine first");

  const job = await db.aiVideoJob.create({ data: { ownerId, prompt: text, seconds, startImageKey } });
  try {
    await queue.send(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.aiVideoJob.update({ where: { id: job.id }, data: { status: "failed", error: message } });
    throw err;
  }
  return job;
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
  const step = (text: string) => db.aiVideoJob.update({ where: { id: jobId }, data: { step: text } });

  try {
    await db.aiVideoJob.update({ where: { id: jobId }, data: { status: "running", step: "Starting the AI engine", error: null } });
    if ((await getAiEngine(db)).status !== "installed") throw new Error("the AI video engine is not installed");

    const generated = path.join(workDir, "generated.mp4");
    const comfy = await startComfy();
    // Progress is written one step at a time, and the last write lands before anything after it.
    let writing: Promise<unknown> = Promise.resolve();
    try {
      let startImage: string | null = null;
      if (job.startImageKey) {
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
          writing = writing.then(() => step(`Generating video ${percent}%`));
        },
      });
      await writing;
      await step("Saving the video");
      await downloadOutput(comfy.url, outputs[0], generated);
    } finally {
      await writing;
      await comfy.stop();
    }

    await step("Converting for Instagram");
    const converted = path.join(workDir, "converted.mp4");
    await convertAiVideo({ input: generated, output: converted });

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
    await db.aiVideoJob.update({ where: { id: jobId }, data: { status: "done", step: null, clipId } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.aiVideoJob.update({ where: { id: jobId }, data: { status: "failed", step: null, error: message } });
    throw err;
  }
}
