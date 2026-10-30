"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { aiDir, startAiEngineInstall, uninstallAiEngine } from "@/lib/ai-engine";
import { requireReadyGpu } from "@/lib/ai-gpu";
import { prisma } from "@/lib/prisma";
import { getAiEngineQueue } from "@/lib/queues";

// The Clips page shows the AI video form only once the engine is installed, so both pages change with it.
export async function installAiEngineAction(): Promise<ActionResult> {
  return runAction(async () => {
    await requireReadyGpu();
    await startAiEngineInstall({ db: prisma, queue: getAiEngineQueue() });
    revalidatePath("/settings");
    revalidatePath("/clips");
    return "Installing the AI video engine";
  });
}

export async function uninstallAiEngineAction(): Promise<ActionResult> {
  return runAction(async () => {
    await uninstallAiEngine({ db: prisma, dir: aiDir() });
    revalidatePath("/settings");
    revalidatePath("/clips");
    return "AI video engine removed";
  });
}
