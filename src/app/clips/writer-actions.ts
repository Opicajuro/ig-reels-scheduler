"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { discardSuggestion, startClipWriting, applySuggestions } from "@/lib/clip-writer";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getClipWriterJobs } from "@/lib/queues";

function clipIds(formData: FormData): string[] {
  return formData.getAll("clipId").map(String);
}

export async function writeWithAiAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const ids = clipIds(formData);
    await startClipWriting({ db: prisma, queue: getClipWriterJobs(), ownerId: await getOwnerId(), clipIds: ids });
    revalidatePath(`/clips/${String(formData.get("projectId"))}`);
    revalidatePath("/queue");
    return ids.length === 1 ? "Writing the title with AI" : `Writing ${ids.length} titles with AI`;
  });
}

export async function applySuggestionsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const count = await applySuggestions({ db: prisma, ownerId: await getOwnerId(), clipIds: clipIds(formData) });
    revalidatePath(`/clips/${String(formData.get("projectId"))}`);
    return count === 1 ? "Title and description filled in" : `Filled in ${count} titles and descriptions`;
  });
}

export async function discardSuggestionAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await discardSuggestion({ db: prisma, ownerId: await getOwnerId(), clipId: String(formData.get("clipId")) });
    revalidatePath(`/clips/${String(formData.get("projectId"))}`);
    return "Suggestion discarded";
  });
}
