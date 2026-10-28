import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  assertHttpUrl,
  MAX_CLIPS,
  parseCaptionPosition,
  parseCaptionPreset,
  parseClipName,
  parseClipSeconds,
  parseProjectName,
  parseUploadDescription,
  parseUploadTitle,
} from "@/clip-engine/helpers.js";
import type { ClipStore } from "./clip-store";
import { validateCaption } from "./caption";
import type { ClipQueue, PublishQueue } from "./queues";
import { checkRights, type AudioSourceValue } from "./rights";
import { publishJobRunAt } from "./scheduling";
import { buildClipKey, buildClipSourceKey, buildReelKey } from "./storage";
import { UserError } from "./user-error";

export const SOURCE_CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

async function ownedProject(db: PrismaClient, ownerId: string, projectId: string) {
  const project = await db.clipProject.findFirst({ where: { id: projectId, ownerId }, include: { clips: true } });
  if (!project) throw new UserError("project not found");
  return project;
}

async function ownedClip(db: PrismaClient, ownerId: string, clipId: string) {
  const clip = await db.clip.findFirst({ where: { id: clipId, project: { ownerId } }, include: { project: true } });
  if (!clip) throw new UserError("clip not found");
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
  if (!contentType) throw new UserError(`unsupported video type "${ext}"`);

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
    throw new UserError("this project is not waiting for an upload");
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
  captionPosition,
  captionUppercase,
}: {
  db: PrismaClient;
  queue: ClipQueue;
  ownerId: string;
  projectId: string;
  clipSeconds: unknown;
  clipCount: unknown;
  withCaptions: boolean;
  captionPreset?: unknown;
  captionPosition?: unknown;
  captionUppercase?: boolean;
}) {
  const project = await ownedProject(db, ownerId, projectId);
  if (project.status === "awaiting_source") throw new UserError("upload the video before making clips");
  if (project.status === "rendering") throw new UserError("clips are already rendering for this project");

  const seconds = parseClipSeconds(clipSeconds);
  // null means Auto: the worker picks the count once it knows the video's length.
  if (clipCount !== null && (typeof clipCount !== "number" || !Number.isInteger(clipCount) || clipCount < 1 || clipCount > MAX_CLIPS)) {
    throw new UserError(`clipCount must be a whole number from 1 to ${MAX_CLIPS}`);
  }
  const preset = withCaptions ? parseCaptionPreset(captionPreset) : null;
  const position = withCaptions ? parseCaptionPosition(captionPosition) : "bottom";
  const uppercase = withCaptions && captionUppercase === true;

  await db.clipProject.update({
    where: { id: projectId },
    data: {
      status: "rendering",
      error: null,
      clipSeconds: seconds,
      clipCount,
      withCaptions,
      captionPreset: preset,
      captionPosition: position,
      captionUppercase: uppercase,
    },
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
  if (project.status === "rendering") throw new UserError("clips are rendering for this project");

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
  if (original.status === "rendering") throw new UserError("clips are rendering for this project");
  if (original.status === "awaiting_source") throw new UserError("upload the video before copying this project");

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
        aiGenerated: clip.aiGenerated,
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
  if (clip.project.status === "rendering") throw new UserError("clips are rendering for this project");

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
      aiGenerated: clip.aiGenerated,
    },
  });
}

export async function deleteClip({ db, store, ownerId, clipId }: { db: PrismaClient; store: ClipStore; ownerId: string; clipId: string }) {
  const clip = await ownedClip(db, ownerId, clipId);
  if (clip.project.status === "rendering") throw new UserError("clips are rendering for this project");

  await store.remove(clip.storageKey);
  await db.clip.delete({ where: { id: clipId } });
}

// Checks one post's caption and time before anything is made.
function checkPost(caption: string, scheduledAt: Date, now: Date) {
  const problems = validateCaption(caption);
  if (problems.length > 0) throw new UserError(problems.join("; "));
  if (Number.isNaN(scheduledAt.getTime())) throw new UserError("the publish time is not valid");
  if (scheduledAt.getTime() <= now.getTime()) throw new UserError("the publish time must be in the future");
}

async function activeAccount(db: PrismaClient, ownerId: string, accountId: string) {
  const account = await db.igAccount.findFirst({ where: { id: accountId, ownerId, status: "active" } });
  if (!account) throw new UserError("account is not connected and active");
  return account;
}

// Makes checked posts all or none. Each clip is copied to its own reel key, so deleting the account later removes
// that copy without touching the project's clip. The publish jobs are queued with the posts' ids before one
// transaction creates every media, post and rights record; if anything fails, the jobs are canceled and the copies
// removed. A job that starts before the transaction commits finds no post yet and is retried.
async function createClipPosts({
  db,
  store,
  queue,
  ownerId,
  accountId,
  audioSource,
  now,
  posts,
}: {
  db: PrismaClient;
  store: ClipStore;
  queue: PublishQueue;
  ownerId: string;
  accountId: string;
  audioSource: AudioSourceValue;
  now: Date;
  posts: Array<{
    clip: { projectId: string; storageKey: string; length: number };
    caption: string;
    scheduledAt: Date;
    siblingAccountCount: number;
    warnings: string[];
  }>;
}) {
  const planned = posts.map((post) => ({ ...post, mediaId: randomUUID(), postId: randomUUID() }));
  const copied: string[] = [];
  const jobs: string[] = [];
  try {
    for (const item of planned) {
      const reelKey = buildReelKey(item.mediaId);
      await store.copy(item.clip.storageKey, reelKey);
      copied.push(reelKey);
    }
    for (const item of planned) {
      jobs.push(await queue.send(item.postId, publishJobRunAt(item.scheduledAt, now)));
    }
    return await db.$transaction(async (tx) => {
      const created = [];
      for (const [index, item] of planned.entries()) {
        const reelKey = copied[index];
        await tx.media.create({
          data: {
            id: item.mediaId,
            accountId,
            rawKey: reelKey,
            reelKey,
            status: "ready",
            durationMs: item.clip.length * 1000,
            width: 1080,
            height: 1920,
            audioSource,
            sourceProjectId: item.clip.projectId,
          },
        });
        const post = await tx.post.create({
          data: {
            id: item.postId,
            accountId,
            mediaId: item.mediaId,
            caption: item.caption,
            shareToFeed: true,
            scheduledAt: item.scheduledAt,
            rightsConfirmedAt: now,
            queueJobId: jobs[index],
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: ownerId,
            action: "rights_confirmed",
            targetType: "Post",
            targetId: post.id,
            data: {
              mediaId: item.mediaId,
              audioSource,
              siblingAccountCount: item.siblingAccountCount,
              warnings: item.warnings,
            },
          },
        });
        created.push(post);
      }
      return created;
    });
  } catch (err) {
    for (const job of jobs) await queue.cancel(job);
    for (const key of copied) await store.remove(key);
    throw err;
  }
}

// Posts a clip to an Instagram account.
export async function scheduleClip({
  db,
  store,
  queue,
  ownerId,
  clipId,
  accountId,
  caption,
  scheduledAt,
  rightsConfirmed,
  audioSource,
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
  rightsConfirmed: boolean;
  audioSource: AudioSourceValue;
  now: Date;
}) {
  const clip = await ownedClip(db, ownerId, clipId);
  if (clip.project.status === "rendering") throw new UserError("clips are rendering for this project");
  await activeAccount(db, ownerId, accountId);

  // Safe-clip gate: nothing is copied or created until the operator confirms the clip's rights.
  const siblingAccountCount = await countOtherAccounts(db, clip.projectId, accountId);
  const rights = checkRights({ rightsConfirmed, audioSource, siblingAccountCount });
  if (!rights.canSchedule) throw new UserError(rights.warnings[0]);
  const at = new Date(scheduledAt);
  checkPost(caption, at, now);

  const [post] = await createClipPosts({
    db,
    store,
    queue,
    ownerId,
    accountId,
    audioSource,
    now,
    posts: [{ clip, caption, scheduledAt: at, siblingAccountCount, warnings: rights.warnings }],
  });
  return post;
}

// Posts several clips to one account under one rights confirmation. Every check runs before the first post is made,
// and the posts are made all or none. Clip i is published at the first time plus i gaps.
export async function scheduleClips({
  db,
  store,
  queue,
  ownerId,
  clipIds,
  accountId,
  firstScheduledAt,
  gapHours,
  rightsConfirmed,
  audioSource,
  now,
}: {
  db: PrismaClient;
  store: ClipStore;
  queue: PublishQueue;
  ownerId: string;
  clipIds: string[];
  accountId: string;
  firstScheduledAt: string;
  gapHours: number;
  rightsConfirmed: boolean;
  audioSource: AudioSourceValue;
  now: Date;
}) {
  const ids = [...new Set(clipIds)];
  if (ids.length === 0) throw new UserError("select at least one clip");
  if (!Number.isInteger(gapHours) || gapHours < 1 || gapHours > 720) {
    throw new UserError("the gap between posts must be a whole number of hours from 1 to 720");
  }
  const first = new Date(firstScheduledAt);
  if (Number.isNaN(first.getTime())) throw new UserError("the first publish time is not valid");
  if (first.getTime() <= now.getTime()) throw new UserError("the first publish time must be in the future");

  const rights = checkRights({ rightsConfirmed, audioSource, siblingAccountCount: 0 });
  if (!rights.canSchedule) throw new UserError(rights.warnings[0]);

  const clips = await db.clip.findMany({ where: { id: { in: ids }, project: { ownerId } }, include: { project: true } });
  if (clips.length !== ids.length) throw new UserError("clip not found");
  if (clips.some((clip) => clip.project.status === "rendering")) throw new UserError("clips are rendering for this project");
  await activeAccount(db, ownerId, accountId);

  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const posts = [];
  for (const [index, clipId] of ids.entries()) {
    const clip = byId.get(clipId);
    if (!clip) throw new UserError("clip not found");
    const caption = clip.description || clip.title || clip.name;
    const scheduledAt = new Date(first.getTime() + index * gapHours * 60 * 60 * 1000);
    const problems = validateCaption(caption);
    if (problems.length > 0) throw new UserError(`${clip.name}: ${problems.join("; ")}`);
    const siblingAccountCount = await countOtherAccounts(db, clip.projectId, accountId);
    const { warnings } = checkRights({ rightsConfirmed, audioSource, siblingAccountCount });
    posts.push({ clip, caption, scheduledAt, siblingAccountCount, warnings });
  }

  return createClipPosts({ db, store, queue, ownerId, accountId, audioSource, now, posts });
}

// Other accounts that already have a live post (scheduled, in progress, or published) made from this clip project.
export async function countOtherAccounts(db: PrismaClient, projectId: string, accountId: string): Promise<number> {
  const posts = await db.post.findMany({
    where: { media: { sourceProjectId: projectId } },
    select: { accountId: true, status: true },
  });
  const others = posts.filter(
    (post) => post.accountId !== accountId && ["scheduled", "container_created", "published"].includes(post.status),
  );
  return new Set(others.map((post) => post.accountId)).size;
}
