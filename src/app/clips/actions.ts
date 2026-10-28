"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getOwnerId } from "@/lib/owner";
import * as clips from "@/lib/clip-projects";
import { s3ClipStore } from "@/lib/clip-store";
import { parseAudioSource } from "@/lib/rights";
import { prisma } from "@/lib/prisma";
import { getClipQueue, getPublishQueue } from "@/lib/queues";

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

export async function createLinkProjectAction(formData: FormData) {
  const project = await clips.createLinkProject({
    db: prisma,
    ownerId: await getOwnerId(),
    name: text(formData, "name"),
    url: text(formData, "url"),
  });
  redirect(`/clips/${project.id}`);
}

export async function markSourceUploadedAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.markSourceUploaded({ db: prisma, ownerId: await getOwnerId(), projectId });
  revalidatePath("/clips");
}

export async function startRenderAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.startRender({
    db: prisma,
    queue: getClipQueue(),
    ownerId: await getOwnerId(),
    projectId,
    clipSeconds: Number(text(formData, "clipSeconds")),
    clipCount: text(formData, "clipCount") === "auto" ? null : Number(text(formData, "clipCount")),
    withCaptions: formData.get("withCaptions") === "on",
    captionPreset: text(formData, "captionPreset"),
    captionPosition: text(formData, "captionPosition"),
    captionUppercase: formData.get("captionUppercase") === "on",
  });
  revalidatePath(`/clips/${projectId}`);
}

export async function renameProjectAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.renameProject({ db: prisma, ownerId: await getOwnerId(), projectId, name: text(formData, "name") });
  revalidatePath(`/clips/${projectId}`);
  revalidatePath("/clips");
}

export async function copyProjectAction(formData: FormData) {
  const copy = await clips.copyProject({
    db: prisma,
    store: s3ClipStore,
    ownerId: await getOwnerId(),
    projectId: text(formData, "projectId"),
  });
  revalidatePath("/clips");
  redirect(`/clips/${copy.id}`);
}

export async function deleteProjectAction(formData: FormData) {
  await clips.deleteProject({
    db: prisma,
    store: s3ClipStore,
    ownerId: await getOwnerId(),
    projectId: text(formData, "projectId"),
  });
  revalidatePath("/clips");
  redirect("/clips");
}

export async function renameClipAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.renameClip({ db: prisma, ownerId: await getOwnerId(), clipId: text(formData, "clipId"), name: text(formData, "name") });
  revalidatePath(`/clips/${projectId}`);
}

export async function copyClipAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.copyClip({ db: prisma, store: s3ClipStore, ownerId: await getOwnerId(), clipId: text(formData, "clipId") });
  revalidatePath(`/clips/${projectId}`);
}

export async function deleteClipAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.deleteClip({ db: prisma, store: s3ClipStore, ownerId: await getOwnerId(), clipId: text(formData, "clipId") });
  revalidatePath(`/clips/${projectId}`);
}

export async function saveClipDetailsAction(formData: FormData) {
  const projectId = text(formData, "projectId");
  await clips.setClipDetails({
    db: prisma,
    ownerId: await getOwnerId(),
    clipId: text(formData, "clipId"),
    title: text(formData, "title"),
    description: text(formData, "description"),
  });
  revalidatePath(`/clips/${projectId}`);
}

export async function scheduleClipAction(formData: FormData) {
  await clips.scheduleClip({
    db: prisma,
    store: s3ClipStore,
    queue: getPublishQueue(),
    ownerId: await getOwnerId(),
    clipId: text(formData, "clipId"),
    accountId: text(formData, "accountId"),
    caption: text(formData, "caption"),
    scheduledAt: text(formData, "scheduledAt"),
    rightsConfirmed: formData.get("rightsConfirmed") === "on",
    audioSource: parseAudioSource(formData.get("audioSource")),
    now: new Date(),
  });
  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function bulkScheduleClipsAction(formData: FormData) {
  await clips.scheduleClips({
    db: prisma,
    store: s3ClipStore,
    queue: getPublishQueue(),
    ownerId: await getOwnerId(),
    clipIds: formData.getAll("clipId").map(String),
    accountId: text(formData, "accountId"),
    firstScheduledAt: text(formData, "scheduledAt"),
    gapHours: Number(text(formData, "gapHours")),
    rightsConfirmed: formData.get("rightsConfirmed") === "on",
    audioSource: parseAudioSource(formData.get("audioSource")),
    now: new Date(),
  });
  revalidatePath("/dashboard");
  redirect("/dashboard");
}
