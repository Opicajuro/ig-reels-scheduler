"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { requireReadyGpu } from "@/lib/ai-gpu";
import { createAiVideo } from "@/lib/ai-video";
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
