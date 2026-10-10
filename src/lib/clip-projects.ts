import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  assertHttpUrl,
  MAX_CLIPS,
  parseCaptionPreset,
  parseClipName,
  parseClipSeconds,
  parseProjectName,
  parseUploadDescription,
  parseUploadTitle,
} from "@/clip-engine/helpers.js";
import type { ClipStore } from "./clip-store";
import { createScheduledPost } from "./posts";
import type { ClipQueue, PublishQueue } from "./queues";
import { buildClipKey, buildClipSourceKey, buildReelKey } from "./storage";

export const SOURCE_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

async function ownedProject(db: PrismaClient, ownerId: string, projectId: string) {
  const project = await db.clipProject.findFirst({ where: { id: projectId, ownerId }, include: { clips: true } });
  if (!project) throw new Error("project not found");
  return project;
}

async function ownedClip(db: PrismaClient, ownerId: string, clipId: string) {
  const clip = await db.clip.findFirst({ where: { id: clipId, project: { ownerId } }, include: { project: true } });
  if (!clip) throw new Error("clip not found");
  return clip;
}

// Creates a project for an uploaded file. The browser sends the file to the returned sourceKey, then marks it uploaded.
export async function createUploadProject({
  db,
  ownerId,
  name,
  extension,
}: {
  db: PrismaClient;
  ownerId: string;
  name: string;
  extension: string;
}) {
  const ext = extension.toLowerCase();
  const contentType = SOURCE_CONTENT_TYPES[ext];
  if (!contentType) throw new Error(`unsupported video type "${ext}"`);

  const project = await db.clipProject.create({
    data: { ownerId, name: parseProjectName(name), status: "awaiting_source" },
  });
  const sourceKey = buildClipSourceKey(project.id, ext);
  await db.clipProject.update({ where: { id: project.id }, data: { sourceKey } });
  return { projectId: project.id, sourceKey, contentType };
}

export async function markSourceUploaded({ db, ownerId, projectId }: { db: PrismaClient; ownerId: string; projectId: string }) {
  const project = await ownedProject(db, ownerId, projectId);
  if (project.status !== "awaiting_source" || !project.sourceKey) {
    throw new Error("this project is not waiting for an upload");
  }
  return db.clipProject.update({ where: { id: projectId }, data: { status: "ready" } });
}

// A link project downloads its video the first time clips are made.
export async function createLinkProject({
  db,
  ownerId,
  name,
  url,
}: {
  db: PrismaClient;
  ownerId: string;
  name: string;
  url: string;
}) {
  return db.clipProject.create({
    data: { ownerId, name: parseProjectName(name), sourceUrl: assertHttpUrl(url), status: "ready" },
  });
}

export async function startRender({
  db,
  queue,
  ownerId,
  projectId,
  clipSeconds,
  clipCount,
  withCaptions,
  captionPreset,
}: {
  db: PrismaClient;
  queue: ClipQueue;
  ownerId: string;
  projectId: string;
  clipSeconds: unknown;
  clipCount: unknown;
  withCaptions: boolean;
  captionPreset?: unknown;
}) {
  const project = await ownedProject(db, ownerId, projectId);
  if (project.status === "awaiting_source") throw new Error("upload the video before making clips");
  if (project.status === "rendering") throw new Error("clips are already rendering for this project");

  const seconds = parseClipSeconds(clipSeconds);
  if (typeof clipCount !== "number" || !Number.isInteger(clipCount) || clipCount < 1 || clipCount > MAX_CLIPS) {
    throw new Error(`clipCount must be a whole number from 1 to ${MAX_CLIPS}`);
  }
  const preset = withCaptions ? parseCaptionPreset(captionPreset) : null;

  await db.clipProject.update({
    where: { id: projectId },
    data: { status: "rendering", error: null, clipSeconds: seconds, clipCount, withCaptions, captionPreset: preset },
  });
  try {
    await queue.send(projectId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.clipProject.update({ where: { id: projectId }, data: { status: "failed", error: message } });
    throw err;
  }
}

export async function renameProject({
  db,
  ownerId,
  projectId,
  name,
}: {
  db: PrismaClient;
  ownerId: string;
  projectId: string;
  name: string;
}) {
  await ownedProject(db, ownerId, projectId);
  return db.clipProject.update({ where: { id: projectId }, data: { name: parseProjectName(name) } });
}

export async function deleteProject({
  db,
  store,
  ownerId,
  projectId,
}: {
  db: PrismaClient;
  store: ClipStore;
  ownerId: string;
  projectId: string;
}) {
  const project = await ownedProject(db, ownerId, projectId);
  if (project.status === "rendering") throw new Error("clips are rendering for this project");

  // Files go first, so a failed delete leaves the rows in place to retry from.
  const keys = [project.sourceKey, ...project.clips.map((clip) => clip.storageKey)];
  for (const key of keys) {
    if (key) await store.remove(key);
  }
  await db.clipProject.delete({ where: { id: projectId } });
}

export async function copyProject({
  db,
  store,
  ownerId,
  projectId,
}: {
  db: PrismaClient;
  store: ClipStore;
  ownerId: string;
  projectId: string;
}) {
  const original = await ownedProject(db, ownerId, projectId);
  if (original.status === "rendering") throw new Error("clips are rendering for this project");
  if (original.status === "awaiting_source") throw new Error("upload the video before copying this project");

  const copy = await db.clipProject.create({
    data: {
      ownerId,
      name: `${original.name} copy`,
      sourceUrl: original.sourceUrl,
      status: original.status,
      error: original.error,
      durationSeconds: original.durationSeconds,
      clipSeconds: original.clipSeconds,
      clipCount: original.clipCount,
      withCaptions: original.withCaptions,
      captionPreset: original.captionPreset,
    },
  });
  if (original.sourceKey) {
    const sourceKey = buildClipSourceKey(copy.id, path.extname(original.sourceKey));
    await store.copy(original.sourceKey, sourceKey);
    await db.clipProject.update({ where: { id: copy.id }, data: { sourceKey } });
  }
  for (const clip of original.clips) {
    const clipId = randomUUID();
    const storageKey = buildClipKey(copy.id, clipId);
    await store.copy(clip.storageKey, storageKey);
    await db.clip.create({
      data: {
        id: clipId,
        projectId: copy.id,
        name: clip.name,
        start: clip.start,
        length: clip.length,
        storageKey,
        title: clip.title,
        description: clip.description,
      },
    });
  }
  return copy;
}

export async function renameClip({ db, ownerId, clipId, name }: { db: PrismaClient; ownerId: string; clipId: string; name: string }) {
  await ownedClip(db, ownerId, clipId);
  return db.clip.update({ where: { id: clipId }, data: { name: parseClipName(name) } });
}

export async function setClipDetails({
  db,
  ownerId,
  clipId,
  title,
  description,
}: {
  db: PrismaClient;
  ownerId: string;
  clipId: string;
  title: unknown;
  description: unknown;
}) {
  await ownedClip(db, ownerId, clipId);
  return db.clip.update({
    where: { id: clipId },
    data: { title: parseUploadTitle(title), description: parseUploadDescription(description) },
  });
}

export async function copyClip({ db, store, ownerId, clipId }: { db: PrismaClient; store: ClipStore; ownerId: string; clipId: string }) {
  const clip = await ownedClip(db, ownerId, clipId);
  if (clip.project.status === "rendering") throw new Error("clips are rendering for this project");

  const copyId = randomUUID();
  const storageKey = buildClipKey(clip.projectId, copyId);
  await store.copy(clip.storageKey, storageKey);
  return db.clip.create({
    data: {
      id: copyId,
      projectId: clip.projectId,
      name: `${clip.name} copy`,
      start: clip.start,
      length: clip.length,
      storageKey,
      title: clip.title,
      description: clip.description,
    },
  });
}

export async function deleteClip({ db, store, ownerId, clipId }: { db: PrismaClient; store: ClipStore; ownerId: string; clipId: string }) {
  const clip = await ownedClip(db, ownerId, clipId);
  if (clip.project.status === "rendering") throw new Error("clips are rendering for this project");

  await store.remove(clip.storageKey);
  await db.clip.delete({ where: { id: clipId } });
}

// Posts a clip to an Instagram account. The clip is copied to the account's own reel key, so deleting the account
// later removes that copy without touching the project's clip.
export async function scheduleClip({
  db,
  store,
  queue,
  ownerId,
  clipId,
  accountId,
  caption,
  scheduledAt,
  now,
}: {
  db: PrismaClient;
  store: ClipStore;
  queue: PublishQueue;
  ownerId: string;
  clipId: string;
  accountId: string;
  caption: string;
  scheduledAt: string;
  now: Date;
}) {
  const clip = await ownedClip(db, ownerId, clipId);
  if (clip.project.status === "rendering") throw new Error("clips are rendering for this project");
  const account = await db.igAccount.findFirst({ where: { id: accountId, ownerId, status: "active" } });
  if (!account) throw new Error("account is not connected and active");

  const mediaId = randomUUID();
  const reelKey = buildReelKey(mediaId);
  await store.copy(clip.storageKey, reelKey);
  await db.media.create({
    data: {
      id: mediaId,
      accountId,
      rawKey: reelKey,
      reelKey,
      status: "ready",
      durationMs: clip.length * 1000,
      width: 1080,
      height: 1920,
    },
  });
  try {
    return await createScheduledPost({
      db,
      queue,
      ownerId,
      input: { accountId, mediaId, caption, scheduledAt, shareToFeed: true },
      now,
    });
  } catch (err) {
    await db.media.delete({ where: { id: mediaId } });
    await store.remove(reelKey);
    throw err;
  }
}
