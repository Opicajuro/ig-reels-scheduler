import { randomUUID } from "node:crypto";
import path from "node:path";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  assertHttpUrl,
  MAX_CLIPS,
  parseCaptionFont,
  parseCaptionHighlight,
  parseCaptionPosition,
  parseCaptionPreset,
  parseEndCardText,
  parseHookMode,
  parseHookText,
  parseProgressBar,
  parseClipName,
  parseClipSeconds,
  parseProjectName,
  parseUploadDescription,
  parseUploadTitle,
} from "@/clip-engine/helpers.js";
import type { ClipStore } from "./clip-store";
import { validateCaption } from "./caption";
import { parseHighlightsJson } from "./highlights";
import type { ClipQueue, PublishQueue, RecaptionQueue } from "./queues";
import { checkRights, type AudioSourceValue } from "./rights";
import { publishJobRunAt } from "./scheduling";
import { buildClipBaseKey, buildClipKey, buildClipSourceKey, buildReelKey, buildYouTubeKey } from "./storage";
import { checkEditedWords, parseClipWords } from "./caption-words";
import { DEFAULT_MUSIC_VOLUME, parseMusicChoice, withCredit } from "./music-library";
import { UserError } from "./user-error";
import { checkYouTubePost, shortsDescription } from "./youtube";
import { youTubeJobRunAt } from "./youtube-posts";

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

const RECAPTIONING = "wait until this clip's captions are re-rendered";

// A clip's caption words and a copy of its kept cut, for its copy with the id copyId in the project projectId.
async function copyCaptionFiles(
  store: ClipStore,
  clip: { words: Prisma.JsonValue; baseKey: string | null },
  projectId: string,
  copyId: string,
) {
  if (!clip.baseKey) return { words: Prisma.DbNull, baseKey: null };
  const baseKey = buildClipBaseKey(projectId, copyId);
  await store.copy(clip.baseKey, baseKey);
  return { words: clip.words ?? Prisma.DbNull, baseKey };
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

// "Make clips", in one of three ways: with review on, it only finds the highlights, for the person to adjust before
// making clips ("picking", then "review"); given the reviewed highlights, it makes exactly those clips; with review
// off, it picks the highlights and makes the clips in one go.
export async function startRender({
  db,
  queue,
  ownerId,
  projectId,
  review = false,
  highlights,
  clipSeconds,
  clipCount,
  withCaptions,
  captionPreset,
  captionPosition,
  captionUppercase,
  captionFont = "default",
  captionHighlight = "yellow",
  captionEmoji = false,
  hookMode = "off",
  hookText = "",
  progressBar = "off",
  endCardText = "",
  musicTrack = "",
  musicVolume = String(DEFAULT_MUSIC_VOLUME),
  tightenPacing = false,
}: {
  db: PrismaClient;
  queue: ClipQueue;
  ownerId: string;
  projectId: string;
  review?: boolean;
  // The reviewed highlights' JSON, sent from the timeline while the project is in review.
  highlights?: string;
  clipSeconds: unknown;
  clipCount: unknown;
  withCaptions: boolean;
  captionPreset?: unknown;
  captionPosition?: unknown;
  captionUppercase?: boolean;
  captionFont?: unknown;
  captionHighlight?: unknown;
  captionEmoji?: boolean;
  hookMode?: unknown;
  hookText?: unknown;
  progressBar?: unknown;
  endCardText?: unknown;
  // A music track id from the library or "" for none, and its volume, 0-100.
  musicTrack?: string;
  musicVolume?: string;
  tightenPacing?: boolean;
}) {
  const project = await ownedProject(db, ownerId, projectId);
  if (project.status === "awaiting_source") throw new UserError("upload the video before making clips");
  if (project.status === "rendering") throw new UserError("clips are already rendering for this project");
  if (project.status === "picking") throw new UserError("the highlights are still being found for this project");
  if (highlights !== undefined && project.status !== "review") {
    throw new UserError("these highlights are no longer being reviewed: find the highlights again");
  }
  const reviewed =
    highlights === undefined ? null : parseHighlightsJson(highlights, requireDuration(project.id, project.durationSeconds));

  const seconds = parseClipSeconds(clipSeconds);
  // null means Auto: the worker picks the count once it knows the video's length.
  if (clipCount !== null && (typeof clipCount !== "number" || !Number.isInteger(clipCount) || clipCount < 1 || clipCount > MAX_CLIPS)) {
    throw new UserError(`clipCount must be a whole number from 1 to ${MAX_CLIPS}`);
  }
  const preset = withCaptions ? parseCaptionPreset(captionPreset) : null;
  const position = withCaptions ? parseCaptionPosition(captionPosition) : "bottom";
  const uppercase = withCaptions && captionUppercase === true;
  const font = parseCaptionFont(captionFont);
  const highlight = withCaptions ? parseCaptionHighlight(captionHighlight) : "yellow";
  const emoji = withCaptions && captionEmoji === true;
  const hook = parseHookMode(hookMode);
  const hookTitle = parseHookText(hookText, hook);
  const music = parseMusicChoice(musicTrack, musicVolume);

  // A new render id: this render starts over, replacing the clips, even if an earlier one was interrupted.
  const renderId = randomUUID();
  await db.clipProject.update({
    where: { id: projectId },
    data: {
      status: reviewed || !review ? "rendering" : "picking",
      highlights: reviewed ?? Prisma.DbNull,
      error: null,
      renderStep: null,
      renderStartedAt: new Date(),
      renderId,
      clipSeconds: seconds,
      clipCount,
      withCaptions,
      captionPreset: preset,
      captionPosition: position,
      captionUppercase: uppercase,
      captionFont: font,
      captionHighlight: highlight,
      captionEmoji: emoji,
      hookMode: hook,
      hookText: hookTitle,
      progressBar: parseProgressBar(progressBar),
      endCardText: parseEndCardText(endCardText),
      ...music,
      tightenPacing,
    },
  });
  try {
    await queue.send(projectId, renderId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.clipProject.update({ where: { id: projectId }, data: { status: "failed", error: message } });
    throw err;
  }
}

function requireDuration(projectId: string, durationSeconds: number | null): number {
  if (durationSeconds === null) throw new Error(`project ${projectId} has highlights to review but no video length`);
  return durationSeconds;
}

// Drops the highlights being reviewed. The project goes back to its clips, or to ready without any.
export async function discardHighlights({ db, ownerId, projectId }: { db: PrismaClient; ownerId: string; projectId: string }) {
  const project = await ownedProject(db, ownerId, projectId);
  if (project.status !== "review") throw new UserError("this project has no highlights to review");
  await db.clipProject.update({
    where: { id: projectId },
    data: { status: project.clips.length > 0 ? "done" : "ready", highlights: Prisma.DbNull, renderStep: null },
  });
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
  if (project.status === "rendering" || project.status === "picking") throw new UserError("clips are rendering for this project");

  // Files go first, so a failed delete leaves the rows in place to retry from.
  const keys = [project.sourceKey, ...project.clips.flatMap((clip) => [clip.storageKey, clip.baseKey])];
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
  if (original.status === "rendering" || original.status === "picking") throw new UserError("clips are rendering for this project");
  if (original.status === "awaiting_source") throw new UserError("upload the video before copying this project");

  const copy = await db.clipProject.create({
    data: {
      ownerId,
      name: `${original.name} copy`,
      sourceUrl: original.sourceUrl,
      status: original.status,
      error: original.error,
      durationSeconds: original.durationSeconds,
      highlights: original.highlights ?? Prisma.DbNull,
      transcript: original.transcript ?? Prisma.DbNull,
      clipSeconds: original.clipSeconds,
      clipCount: original.clipCount,
      withCaptions: original.withCaptions,
      captionPreset: original.captionPreset,
      captionPosition: original.captionPosition,
      captionUppercase: original.captionUppercase,
      captionFont: original.captionFont,
      captionHighlight: original.captionHighlight,
      captionEmoji: original.captionEmoji,
      hookMode: original.hookMode,
      hookText: original.hookText,
      progressBar: original.progressBar,
      endCardText: original.endCardText,
      musicTrack: original.musicTrack,
      musicVolume: original.musicVolume,
      tightenPacing: original.tightenPacing,
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
        musicTrack: clip.musicTrack,
        ...(await copyCaptionFiles(store, clip, copy.id, clipId)),
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
  if (clip.recaptionId) throw new UserError(RECAPTIONING);

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
      musicTrack: clip.musicTrack,
      ...(await copyCaptionFiles(store, clip, clip.projectId, copyId)),
    },
  });
}

// The owner's clips for a change to several at once, in the order asked. None may be in a project that is rendering.
async function ownedClips(db: PrismaClient, ownerId: string, clipIds: string[]) {
  const ids = [...new Set(clipIds)];
  if (ids.length === 0) throw new UserError("select at least one clip");
  const clips = await db.clip.findMany({ where: { id: { in: ids }, project: { ownerId } }, include: { project: true } });
  if (clips.length !== ids.length) throw new UserError("clip not found");
  if (clips.some((clip) => clip.project.status === "rendering")) throw new UserError("clips are rendering for this project");
  if (clips.some((clip) => clip.recaptionId)) throw new UserError(RECAPTIONING);
  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  return ids.map((id) => byId.get(id)!);
}

export async function deleteClip({ db, store, ownerId, clipId }: { db: PrismaClient; store: ClipStore; ownerId: string; clipId: string }) {
  await deleteClips({ db, store, ownerId, clipIds: [clipId] });
}

// A clip's scheduled posts have their own copies (createClipPosts), so deleting clips never touches a post.
export async function deleteClips({
  db,
  store,
  ownerId,
  clipIds,
}: {
  db: PrismaClient;
  store: ClipStore;
  ownerId: string;
  clipIds: string[];
}) {
  const clips = await ownedClips(db, ownerId, clipIds);
  // Files go first, so a failed delete leaves the rows in place to retry from.
  for (const clip of clips) {
    await store.remove(clip.storageKey);
    if (clip.baseKey) await store.remove(clip.baseKey);
  }
  await db.clip.deleteMany({ where: { id: { in: clips.map((clip) => clip.id) } } });
  return clips.length;
}

// The project clips are moved or copied to: the owner's, not rendering, and not where any of the clips already are.
async function targetProject(db: PrismaClient, ownerId: string, projectId: string, clips: Array<{ projectId: string }>) {
  const target = await ownedProject(db, ownerId, projectId);
  if (target.status === "rendering") throw new UserError("clips are rendering for that project");
  if (clips.some((clip) => clip.projectId === target.id)) throw new UserError("the clips are already in that project: pick another project");
  return target;
}

// The name itself when it is free, otherwise the name with " (2)", " (3)"… after it. The chosen name becomes taken.
function freeName(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (${n})`;
  taken.add(candidate);
  return candidate;
}

// A clip's file key includes its project, so a moved clip's file is copied to its new key before the old one goes.
export async function moveClipsToProject({
  db,
  store,
  ownerId,
  clipIds,
  projectId,
}: {
  db: PrismaClient;
  store: ClipStore;
  ownerId: string;
  clipIds: string[];
  projectId: string;
}) {
  const clips = await ownedClips(db, ownerId, clipIds);
  const target = await targetProject(db, ownerId, projectId, clips);
  const taken = new Set(target.clips.map((clip) => clip.name));
  for (const clip of clips) {
    const storageKey = buildClipKey(target.id, clip.id);
    await store.copy(clip.storageKey, storageKey);
    const baseKey = clip.baseKey ? buildClipBaseKey(target.id, clip.id) : null;
    if (clip.baseKey && baseKey) await store.copy(clip.baseKey, baseKey);
    await db.clip.update({
      where: { id: clip.id },
      data: { projectId: target.id, name: freeName(clip.name, taken), storageKey, baseKey },
    });
    await store.remove(clip.storageKey);
    if (clip.baseKey) await store.remove(clip.baseKey);
  }
  return { projectName: target.name, count: clips.length };
}

export async function copyClipsToProject({
  db,
  store,
  ownerId,
  clipIds,
  projectId,
}: {
  db: PrismaClient;
  store: ClipStore;
  ownerId: string;
  clipIds: string[];
  projectId: string;
}) {
  const clips = await ownedClips(db, ownerId, clipIds);
  const target = await targetProject(db, ownerId, projectId, clips);
  const taken = new Set(target.clips.map((clip) => clip.name));
  for (const clip of clips) {
    const copyId = randomUUID();
    const storageKey = buildClipKey(target.id, copyId);
    await store.copy(clip.storageKey, storageKey);
    await db.clip.create({
      data: {
        id: copyId,
        projectId: target.id,
        name: freeName(clip.name, taken),
        start: clip.start,
        length: clip.length,
        storageKey,
        title: clip.title,
        description: clip.description,
        aiGenerated: clip.aiGenerated,
        musicTrack: clip.musicTrack,
        ...(await copyCaptionFiles(store, clip, target.id, copyId)),
      },
    });
  }
  return { projectName: target.name, count: clips.length };
}

// Queues drawing a clip's captions again from the words edited in its Captions tab (a JSON list of its words).
export async function startRecaption({
  db,
  queue,
  ownerId,
  clipId,
  words,
}: {
  db: PrismaClient;
  queue: RecaptionQueue;
  ownerId: string;
  clipId: string;
  words: string;
}) {
  const clip = await ownedClip(db, ownerId, clipId);
  if (clip.project.status === "rendering" || clip.project.status === "picking") {
    throw new UserError("clips are being made for this project");
  }
  if (clip.recaptionId) throw new UserError("this clip's captions are already being re-rendered");
  if (clip.words === null || !clip.baseKey) throw new UserError("Captions can be edited on clips made after this update");
  if (!clip.project.captionPreset) throw new UserError("choose a caption style for this project first");
  const edited = checkEditedWords(parseClipWords(clip.words), JSON.parse(words));

  const recaptionId = randomUUID();
  const { count } = await db.clip.updateMany({
    where: { id: clipId, recaptionId: null },
    data: { recaptionId, recaptionStep: null, recaptionWords: edited, recaptionError: null },
  });
  if (count === 0) throw new UserError("this clip's captions are already being re-rendered");
  try {
    await queue.send(clipId, recaptionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.clip.updateMany({
      where: { id: clipId, recaptionId },
      data: { recaptionId: null, recaptionWords: Prisma.DbNull, recaptionError: message },
    });
    throw err;
  }
}

// Checks one post's time before anything is made.
function checkTime(scheduledAt: Date, now: Date) {
  if (Number.isNaN(scheduledAt.getTime())) throw new UserError("the publish time is not valid");
  if (scheduledAt.getTime() <= now.getTime()) throw new UserError("the publish time must be in the future");
}

function checkInstagramCaption(caption: string, clipName?: string) {
  const problems = validateCaption(caption);
  if (problems.length > 0) throw new UserError(`${clipName ? `${clipName}: ` : ""}${problems.join("; ")}`);
}

async function activeAccounts(db: PrismaClient, ownerId: string, accountIds: string[]) {
  for (const accountId of accountIds) {
    const account = await db.igAccount.findFirst({ where: { id: accountId, ownerId, status: "active" } });
    if (!account) throw new UserError("account is not connected and active");
  }
}

// Where a clip goes on YouTube, and how. Each post is uploaded at its publish time by its own youtube-publish job.
export type YouTubeTarget = {
  queue: PublishQueue;
  ytAccountIds: string[];
  privacy: string;
  /** "yes" or "no": YouTube requires the answer */
  madeForKids: string;
  /** the one-clip form's title; several clips each use their title, or their name */
  title?: string;
};

// Every Localirs clip is rendered 1080×1920 (src/clip-engine).
const CLIP_WIDTH = 1080;
const CLIP_HEIGHT = 1920;
const PRIVACIES = ["public", "unlisted", "private"] as const;

async function checkYouTubeTarget(db: PrismaClient, ownerId: string, youtube: YouTubeTarget) {
  const privacy = PRIVACIES.find((value) => value === youtube.privacy);
  if (!privacy) throw new UserError("choose whether the YouTube Short is public, unlisted or private");
  if (youtube.madeForKids !== "yes" && youtube.madeForKids !== "no") {
    throw new UserError("say whether the YouTube Short is made for kids; YouTube requires it");
  }
  for (const ytAccountId of youtube.ytAccountIds) {
    const channel = await db.ytAccount.findFirst({ where: { id: ytAccountId, ownerId, status: "active" } });
    if (!channel) throw new UserError("the YouTube channel is not connected and active");
  }
  return { privacy, madeForKids: youtube.madeForKids === "yes" };
}

// A clip's YouTube title and description, checked against YouTube's limits and the Shorts rules.
function youTubeText(clip: { name: string; length: number }, title: string, caption: string) {
  const description = shortsDescription(caption);
  const problems = checkYouTubePost({ title, description, seconds: clip.length, width: CLIP_WIDTH, height: CLIP_HEIGHT });
  if (problems.length > 0) throw new UserError(`${clip.name}: ${problems.join("; ")}`);
  return { title: title.trim(), description };
}

type ClipRef = { id: string; projectId: string; storageKey: string; length: number };

type InstagramPlan = {
  accountId: string;
  clip: ClipRef;
  caption: string;
  scheduledAt: Date;
  aiGenerated: boolean;
  siblingAccountCount: number;
  warnings: string[];
};

type YouTubePlan = {
  ytAccountId: string;
  clip: ClipRef;
  title: string;
  description: string;
  scheduledAt: Date;
  aiGenerated: boolean;
  privacy: (typeof PRIVACIES)[number];
  madeForKids: boolean;
};

// Makes checked posts all or none. Each clip is copied to the post's own key (a reel key for Instagram, a YouTube key),
// so deleting the clip or the account later leaves the other untouched. The jobs are queued with the posts' ids before
// one transaction creates every media, post and rights record; if anything fails, the jobs are canceled and the copies
// removed. A job that starts before the transaction commits finds no post yet and is retried.
async function createClipPosts({
  db,
  store,
  queue,
  ytQueue,
  ownerId,
  audioSource,
  now,
  posts,
  ytPosts,
}: {
  db: PrismaClient;
  store: ClipStore;
  queue: PublishQueue;
  ytQueue: PublishQueue | null;
  ownerId: string;
  audioSource: AudioSourceValue;
  now: Date;
  posts: InstagramPlan[];
  ytPosts: YouTubePlan[];
}) {
  const planned = posts.map((post) => ({ ...post, mediaId: randomUUID(), postId: randomUUID() }));
  const ytPlanned = ytPosts.map((post) => {
    const postId = randomUUID();
    return { ...post, postId, videoKey: buildYouTubeKey(postId) };
  });
  if (ytPlanned.length > 0 && !ytQueue) throw new Error("YouTube posts need the youtube-publish queue");
  const copied: string[] = [];
  const jobs: Array<{ queue: PublishQueue; id: string }> = [];
  try {
    for (const item of planned) {
      const reelKey = buildReelKey(item.mediaId);
      await store.copy(item.clip.storageKey, reelKey);
      copied.push(reelKey);
    }
    for (const item of ytPlanned) {
      await store.copy(item.clip.storageKey, item.videoKey);
      copied.push(item.videoKey);
    }
    for (const item of planned) {
      jobs.push({ queue, id: await queue.send(item.postId, publishJobRunAt(item.scheduledAt, now)) });
    }
    for (const item of ytPlanned) {
      const yt = ytQueue as PublishQueue;
      jobs.push({ queue: yt, id: await yt.send(item.postId, youTubeJobRunAt(item.scheduledAt, now)) });
    }
    return await db.$transaction(async (tx) => {
      const created = [];
      for (const [index, item] of planned.entries()) {
        const reelKey = copied[index];
        await tx.media.create({
          data: {
            id: item.mediaId,
            accountId: item.accountId,
            rawKey: reelKey,
            reelKey,
            status: "ready",
            durationMs: item.clip.length * 1000,
            width: CLIP_WIDTH,
            height: CLIP_HEIGHT,
            audioSource,
            sourceProjectId: item.clip.projectId,
            sourceClipId: item.clip.id,
          },
        });
        const post = await tx.post.create({
          data: {
            id: item.postId,
            accountId: item.accountId,
            mediaId: item.mediaId,
            caption: item.caption,
            shareToFeed: true,
            aiGenerated: item.aiGenerated,
            scheduledAt: item.scheduledAt,
            rightsConfirmedAt: now,
            queueJobId: jobs[index].id,
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
      const ytCreated = [];
      for (const [index, item] of ytPlanned.entries()) {
        const post = await tx.ytPost.create({
          data: {
            id: item.postId,
            ytAccountId: item.ytAccountId,
            videoKey: item.videoKey,
            durationMs: item.clip.length * 1000,
            sourceProjectId: item.clip.projectId,
            sourceClipId: item.clip.id,
            title: item.title,
            description: item.description,
            privacy: item.privacy,
            madeForKids: item.madeForKids,
            aiGenerated: item.aiGenerated,
            scheduledAt: item.scheduledAt,
            rightsConfirmedAt: now,
            queueJobId: jobs[planned.length + index].id,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: ownerId,
            action: "rights_confirmed",
            targetType: "YtPost",
            targetId: post.id,
            data: { audioSource },
          },
        });
        ytCreated.push(post);
      }
      return { posts: created, ytPosts: ytCreated };
    });
  } catch (err) {
    for (const job of jobs) await job.queue.cancel(job.id);
    for (const key of copied) await store.remove(key);
    throw err;
  }
}

// Posts a clip to Instagram accounts and YouTube channels, at least one of them. A clip made with AI always carries
// Instagram's AI info label and YouTube's altered or synthetic content disclosure; aiGenerated adds them to any other
// clip. The caption is the YouTube description too, with #Shorts.
export async function scheduleClip({
  db,
  store,
  queue,
  ownerId,
  clipId,
  accountIds,
  youtube,
  caption,
  scheduledAt,
  aiGenerated,
  rightsConfirmed,
  audioSource,
  now,
}: {
  db: PrismaClient;
  store: ClipStore;
  queue: PublishQueue;
  ownerId: string;
  clipId: string;
  accountIds: string[];
  youtube?: YouTubeTarget;
  caption: string;
  scheduledAt: string;
  aiGenerated: boolean;
  rightsConfirmed: boolean;
  audioSource: AudioSourceValue;
  now: Date;
}) {
  const igIds = [...new Set(accountIds)];
  const ytIds = [...new Set(youtube?.ytAccountIds ?? [])];
  if (igIds.length === 0 && ytIds.length === 0) throw new UserError("choose at least one Instagram account or YouTube channel");
  const clip = await ownedClip(db, ownerId, clipId);
  if (clip.project.status === "rendering") throw new UserError("clips are rendering for this project");
  await activeAccounts(db, ownerId, igIds);
  const ytChoice = youtube && ytIds.length > 0 ? await checkYouTubeTarget(db, ownerId, youtube) : null;

  // Safe-clip gate: nothing is copied or created until the operator confirms the clip's rights.
  const rights = checkRights({ rightsConfirmed, audioSource, siblingAccountCount: 0 });
  if (!rights.canSchedule) throw new UserError(rights.warnings[0]);
  const at = new Date(scheduledAt);
  checkTime(at, now);
  if (igIds.length > 0) checkInstagramCaption(caption);
  const ai = clip.aiGenerated || aiGenerated;

  const posts: InstagramPlan[] = [];
  for (const accountId of igIds) {
    const siblingAccountCount = await countOtherAccounts(db, clip.projectId, accountId);
    const { warnings } = checkRights({ rightsConfirmed, audioSource, siblingAccountCount });
    posts.push({ accountId, clip, caption, scheduledAt: at, aiGenerated: ai, siblingAccountCount, warnings });
  }
  const ytPosts: YouTubePlan[] = [];
  if (ytChoice) {
    const text = youTubeText(clip, youtube?.title ?? clip.title ?? clip.name, caption);
    for (const ytAccountId of ytIds) ytPosts.push({ ytAccountId, clip, ...text, scheduledAt: at, aiGenerated: ai, ...ytChoice });
  }

  return createClipPosts({ db, store, queue, ytQueue: youtube?.queue ?? null, ownerId, audioSource, now, posts, ytPosts });
}

// Posts several clips to Instagram accounts and YouTube channels under one rights confirmation. Every check runs before
// the first post is made, and the posts are made all or none. Clip i is published at the first time plus i gaps, on
// every destination. Clips made with AI always carry the AI label and disclosure; aiGenerated adds them to the others.
export async function scheduleClips({
  db,
  store,
  queue,
  ownerId,
  clipIds,
  accountIds,
  youtube,
  firstScheduledAt,
  gapHours,
  aiGenerated,
  rightsConfirmed,
  audioSource,
  now,
}: {
  db: PrismaClient;
  store: ClipStore;
  queue: PublishQueue;
  ownerId: string;
  clipIds: string[];
  accountIds: string[];
  youtube?: YouTubeTarget;
  firstScheduledAt: string;
  gapHours: number;
  aiGenerated: boolean;
  rightsConfirmed: boolean;
  audioSource: AudioSourceValue;
  now: Date;
}) {
  const ids = [...new Set(clipIds)];
  if (ids.length === 0) throw new UserError("select at least one clip");
  const igIds = [...new Set(accountIds)];
  const ytIds = [...new Set(youtube?.ytAccountIds ?? [])];
  if (igIds.length === 0 && ytIds.length === 0) throw new UserError("choose at least one Instagram account or YouTube channel");
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
  await activeAccounts(db, ownerId, igIds);
  const ytChoice = youtube && ytIds.length > 0 ? await checkYouTubeTarget(db, ownerId, youtube) : null;

  const byId = new Map(clips.map((clip) => [clip.id, clip]));
  const posts: InstagramPlan[] = [];
  const ytPosts: YouTubePlan[] = [];
  for (const [index, clipId] of ids.entries()) {
    const clip = byId.get(clipId);
    if (!clip) throw new UserError("clip not found");
    // A clip made with a CC BY track carries its credit line, which the bulk form shows.
    const caption = withCredit(clip.description || clip.title || clip.name, clip.musicTrack);
    const scheduledAt = new Date(first.getTime() + index * gapHours * 60 * 60 * 1000);
    const ai = clip.aiGenerated || aiGenerated;
    if (igIds.length > 0) checkInstagramCaption(caption, clip.name);
    for (const accountId of igIds) {
      const siblingAccountCount = await countOtherAccounts(db, clip.projectId, accountId);
      const { warnings } = checkRights({ rightsConfirmed, audioSource, siblingAccountCount });
      posts.push({ accountId, clip, caption, scheduledAt, aiGenerated: ai, siblingAccountCount, warnings });
    }
    if (ytChoice) {
      const text = youTubeText(clip, clip.title || clip.name, caption);
      for (const ytAccountId of ytIds) ytPosts.push({ ytAccountId, clip, ...text, scheduledAt, aiGenerated: ai, ...ytChoice });
    }
  }

  return createClipPosts({ db, store, queue, ytQueue: youtube?.queue ?? null, ownerId, audioSource, now, posts, ytPosts });
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
