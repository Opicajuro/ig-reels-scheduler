"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import * as clips from "@/lib/clip-projects";
import { s3ClipStore } from "@/lib/clip-store";
import { addClipLink, removeClipLink } from "@/lib/links";
import { parseAudioSource } from "@/lib/rights";
import { prisma } from "@/lib/prisma";
import { requireEnv } from "@/lib/env";
import { requireFreeSpace } from "@/lib/free-space";
import {
  getClipQueue,
  getFacebookPublishQueue,
  getPublishQueue,
  getRecaptionJobs,
  getTikTokPublishQueue,
  getYouTubePublishQueue,
} from "@/lib/queues";

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

// An automatic sound's box and its sound picker: the sound, or null when the box is off.
function autoSound(formData: FormData, name: string): string | null {
  return formData.get(name) === "on" ? text(formData, `${name}Sound`) : null;
}

// The destination boxes: Instagram accounts as accountId, YouTube channels as ytAccountId with the YouTube choices,
// Facebook Pages as fbPageId and TikTok accounts as ttAccountId.
function destinations(formData: FormData, withTitle: boolean) {
  return {
    accountIds: formData.getAll("accountId").map(String),
    youtube: {
      queue: getYouTubePublishQueue(),
      ytAccountIds: formData.getAll("ytAccountId").map(String),
      privacy: text(formData, "ytPrivacy"),
      madeForKids: text(formData, "ytMadeForKids"),
      ...(withTitle ? { title: text(formData, "ytTitle") } : {}),
    },
    facebook: { queue: getFacebookPublishQueue(), fbPageIds: formData.getAll("fbPageId").map(String) },
    tiktok: { queue: getTikTokPublishQueue(), ttAccountIds: formData.getAll("ttAccountId").map(String) },
  };
}

function scheduledMessage(result: { posts: unknown[]; ytPosts: unknown[]; fbPosts: unknown[]; ttPosts: unknown[] }): string {
  const count = result.posts.length + result.ytPosts.length + result.fbPosts.length + result.ttPosts.length;
  return `Scheduled ${count} ${count === 1 ? "post" : "posts"}`;
}

export async function createLinkProjectAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const project = await clips.createLinkProject({
      db: prisma,
      ownerId: await getOwnerId(),
      name: text(formData, "name"),
      url: text(formData, "url"),
    });
    redirect(`/clips/${project.id}`);
  });
}

export async function markSourceUploadedAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.markSourceUploaded({ db: prisma, ownerId: await getOwnerId(), projectId });
  revalidatePath("/clips");
}

export async function startRenderAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    // The button pressed: "reviewed" makes the clips from the timeline's highlights, "pick" finds them again.
    const intent = text(formData, "intent");
    if (!["", "pick", "reviewed"].includes(intent)) throw new Error(`unknown intent "${intent}"`);
    const review = intent === "pick" || (intent === "" && formData.get("review") === "on");
    await requireFreeSpace(requireEnv("LOCALIRS_DATA_DIR"));
    await clips.startRender({
      db: prisma,
      queue: getClipQueue(),
      ownerId: await getOwnerId(),
      projectId,
      review,
      highlights: intent === "reviewed" ? text(formData, "highlights") : undefined,
      clipSeconds: Number(text(formData, "clipSeconds")),
      clipCount: text(formData, "clipCount") === "auto" ? null : Number(text(formData, "clipCount")),
      withCaptions: formData.get("withCaptions") === "on",
      captionPreset: text(formData, "captionPreset"),
      captionPosition: text(formData, "captionPosition"),
      captionUppercase: formData.get("captionUppercase") === "on",
      captionFont: text(formData, "captionFont"),
      captionHighlight: text(formData, "captionHighlight"),
      captionEmoji: formData.get("captionEmoji") === "on",
      hookMode: text(formData, "hookMode"),
      hookText: text(formData, "hookText"),
      progressBar: text(formData, "progressBar"),
      endCardText: text(formData, "endCardText"),
      musicTrack: text(formData, "musicTrack"),
      musicVolume: text(formData, "musicVolume"),
      tightenPacing: formData.get("tightenPacing") === "on",
      sfxHook: autoSound(formData, "sfxHook"),
      sfxCaptions: autoSound(formData, "sfxCaptions"),
      sfxCuts: autoSound(formData, "sfxCuts"),
      crop: text(formData, "crop"),
    });
    revalidatePath(`/clips/${projectId}`);
    return review ? "Finding highlights" : "Making clips";
  });
}

export async function discardHighlightsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    await clips.discardHighlights({ db: prisma, ownerId: await getOwnerId(), projectId });
    revalidatePath(`/clips/${projectId}`);
    return "Highlights discarded";
  });
}

export async function renameProjectAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    await clips.renameProject({ db: prisma, ownerId: await getOwnerId(), projectId, name: text(formData, "name") });
    revalidatePath(`/clips/${projectId}`);
    revalidatePath("/clips");
    return "Renamed";
  });
}

export async function copyProjectAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const copy = await clips.copyProject({
      db: prisma,
      store: s3ClipStore,
      ownerId: await getOwnerId(),
      projectId: text(formData, "projectId"),
    });
    revalidatePath("/clips");
    redirect(`/clips/${copy.id}`);
  });
}

export async function deleteProjectAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await clips.deleteProject({
      db: prisma,
      store: s3ClipStore,
      ownerId: await getOwnerId(),
      projectId: text(formData, "projectId"),
    });
    revalidatePath("/clips");
    redirect("/clips");
  });
}

export async function renameClipAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    await clips.renameClip({ db: prisma, ownerId: await getOwnerId(), clipId: text(formData, "clipId"), name: text(formData, "name") });
    revalidatePath(`/clips/${projectId}`);
    return "Renamed";
  });
}

export async function copyClipAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    await clips.copyClip({ db: prisma, store: s3ClipStore, ownerId: await getOwnerId(), clipId: text(formData, "clipId") });
    revalidatePath(`/clips/${projectId}`);
    return "Copied";
  });
}

export async function recaptionClipAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    await clips.startRecaption({
      db: prisma,
      queue: getRecaptionJobs(),
      ownerId: await getOwnerId(),
      clipId: text(formData, "clipId"),
      words: text(formData, "words"),
    });
    revalidatePath(`/clips/${projectId}`);
    revalidatePath("/queue");
    return "Re-rendering the captions";
  });
}

export async function deleteClipAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    await clips.deleteClip({ db: prisma, store: s3ClipStore, ownerId: await getOwnerId(), clipId: text(formData, "clipId") });
    revalidatePath(`/clips/${projectId}`);
    return "Deleted";
  });
}

export async function deleteClipsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    const count = await clips.deleteClips({
      db: prisma,
      store: s3ClipStore,
      ownerId: await getOwnerId(),
      clipIds: formData.getAll("clipId").map(String),
    });
    revalidatePath(`/clips/${projectId}`);
    return `Deleted ${count} ${count === 1 ? "clip" : "clips"}`;
  });
}

export async function moveClipsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const targetProjectId = text(formData, "targetProjectId");
    const moved = await clips.moveClipsToProject({
      db: prisma,
      store: s3ClipStore,
      ownerId: await getOwnerId(),
      clipIds: formData.getAll("clipId").map(String),
      projectId: targetProjectId,
    });
    revalidatePath(`/clips/${text(formData, "projectId")}`);
    revalidatePath(`/clips/${targetProjectId}`);
    revalidatePath("/clips");
    return `Moved ${moved.count} ${moved.count === 1 ? "clip" : "clips"} to ${moved.projectName}`;
  });
}

export async function copyClipsToProjectAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const targetProjectId = text(formData, "targetProjectId");
    const copied = await clips.copyClipsToProject({
      db: prisma,
      store: s3ClipStore,
      ownerId: await getOwnerId(),
      clipIds: formData.getAll("clipId").map(String),
      projectId: targetProjectId,
    });
    revalidatePath(`/clips/${targetProjectId}`);
    revalidatePath("/clips");
    return `Copied ${copied.count} ${copied.count === 1 ? "clip" : "clips"} to ${copied.projectName}`;
  });
}

export async function saveClipDetailsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = text(formData, "projectId");
    await clips.setClipDetails({
      db: prisma,
      ownerId: await getOwnerId(),
      clipId: text(formData, "clipId"),
      title: text(formData, "title"),
      description: text(formData, "description"),
    });
    revalidatePath(`/clips/${projectId}`);
    return "Saved";
  });
}

export async function scheduleClipAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const result = await clips.scheduleClip({
      db: prisma,
      store: s3ClipStore,
      queue: getPublishQueue(),
      ownerId: await getOwnerId(),
      clipId: text(formData, "clipId"),
      ...destinations(formData, true),
      caption: text(formData, "caption"),
      scheduledAt: text(formData, "scheduledAt"),
      aiGenerated: formData.get("aiGenerated") === "on",
      rightsConfirmed: formData.get("rightsConfirmed") === "on",
      audioSource: parseAudioSource(formData.get("audioSource")),
      now: new Date(),
    });
    revalidatePath(`/clips/${text(formData, "projectId")}`);
    revalidatePath("/scheduled");
    return scheduledMessage(result);
  });
}

export async function bulkScheduleClipsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const result = await clips.scheduleClips({
      db: prisma,
      store: s3ClipStore,
      queue: getPublishQueue(),
      ownerId: await getOwnerId(),
      clipIds: formData.getAll("clipId").map(String),
      ...destinations(formData, false),
      firstScheduledAt: text(formData, "scheduledAt"),
      gapHours: Number(text(formData, "gapHours")),
      aiGenerated: formData.get("aiGenerated") === "on",
      rightsConfirmed: formData.get("rightsConfirmed") === "on",
      audioSource: parseAudioSource(formData.get("audioSource")),
      now: new Date(),
    });
    revalidatePath(`/clips/${text(formData, "projectId")}`);
    revalidatePath("/scheduled");
    return scheduledMessage(result);
  });
}

export async function addClipLinkAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await addClipLink({ db: prisma, ownerId: await getOwnerId(), clipId: text(formData, "clipId"), url: text(formData, "url") });
    revalidatePath(`/clips/${text(formData, "projectId")}`);
    revalidatePath("/scheduled");
    return "Link added";
  });
}

export async function removeClipLinkAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await removeClipLink({ db: prisma, ownerId: await getOwnerId(), linkId: text(formData, "linkId") });
    revalidatePath(`/clips/${text(formData, "projectId")}`);
    revalidatePath("/scheduled");
    return "Link removed";
  });
}
