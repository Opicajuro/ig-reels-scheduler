"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { aiDir, startAiEngineInstall, uninstallAiEngine } from "@/lib/ai-engine";
import { checkGpu } from "@/lib/ai-gpu";
import { createAiVideo } from "@/lib/ai-video";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getAiEngineQueue, getAiVideoQueue } from "@/lib/queues";
import { UserError } from "@/lib/user-error";

// The page hides these when the graphics card is not good enough; a form sent anyway gets the same answer.
async function requireReadyGpu() {
  const check = await checkGpu();
  if (!check.found) throw new UserError(check.reason);
  if (!check.ready) throw new UserError("this graphics card has too little video memory for AI videos (12 GB at least)");
}

export async function installAiEngineAction(): Promise<ActionResult> {
  return runAction(async () => {
    await requireReadyGpu();
    await startAiEngineInstall({ db: prisma, queue: getAiEngineQueue() });
    revalidatePath("/ai");
    return "Installing the AI video engine";
  });
}

export async function uninstallAiEngineAction(): Promise<ActionResult> {
  return runAction(async () => {
    await uninstallAiEngine({ db: prisma, dir: aiDir() });
    revalidatePath("/ai");
    return "AI video engine removed";
  });
}

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
    revalidatePath("/ai");
    return "Making the video";
  });
}
