"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { startResound } from "@/lib/clip-projects";
import { prisma } from "@/lib/prisma";
import { getRecaptionJobs } from "@/lib/queues";

export async function resoundClipAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = String(formData.get("projectId") ?? "");
    await startResound({
      db: prisma,
      queue: getRecaptionJobs(),
      ownerId: await getOwnerId(),
      clipId: String(formData.get("clipId") ?? ""),
      sounds: String(formData.get("sounds") ?? ""),
    });
    revalidatePath(`/clips/${projectId}`);
    revalidatePath("/queue");
    return "Re-rendering the sounds";
  });
}
