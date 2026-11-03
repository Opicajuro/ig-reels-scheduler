"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { requireReadyGpu } from "@/lib/ai-gpu";
import { AI_CLIP_LABELS, type AiClipKind } from "@/lib/ai-clip-options";
import { createAiClipVideo, createAiVideo } from "@/lib/ai-video";
import { UserError } from "@/lib/user-error";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getAiVideoQueue } from "@/lib/queues";

export async function createAiVideoAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await requireReadyGpu();
    const startImageKey = String(formData.get("startImageKey") ?? "");
    await createAiVideo({
      db: prisma,
      queue: getAiVideoQueue(),
      ownerId: await getOwnerId(),
      prompt: String(formData.get("prompt") ?? ""),
      seconds: Number(formData.get("seconds")),
      startImageKey: startImageKey === "" ? null : startImageKey,
    });
    revalidatePath("/clips");
    return "Making the video";
  });
}

// An AI intro or B-roll on a clip of the project page. The new clip appears in the project when the worker is done.
export async function createAiClipAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const kind = String(formData.get("kind"));
    if (kind !== "intro" && kind !== "broll") throw new UserError("unknown AI clip kind");
    await requireReadyGpu();
    const at = String(formData.get("at") ?? "");
    await createAiClipVideo({
      db: prisma,
      queue: getAiVideoQueue(),
      ownerId: await getOwnerId(),
      clipId: String(formData.get("clipId") ?? ""),
      kind: kind satisfies AiClipKind,
      prompt: String(formData.get("prompt") ?? ""),
      seconds: Number(formData.get("seconds")),
      at: at === "" ? null : Number(at),
    });
    revalidatePath("/queue");
    return `Making the ${AI_CLIP_LABELS[kind]}. It is added to this project when it is done; follow it on the Queue page.`;
  });
}
