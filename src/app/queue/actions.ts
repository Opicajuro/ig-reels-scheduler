"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { interruptComfy } from "@/lib/comfy";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getAiVideoJobs, getClipJobs } from "@/lib/queues";
import { cancelAiVideo, cancelRender } from "@/lib/work-queue";

export async function cancelRenderAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const projectId = String(formData.get("projectId"));
    await cancelRender({ db: prisma, jobs: getClipJobs(), ownerId: await getOwnerId(), projectId });
    revalidatePath("/clips");
    revalidatePath(`/clips/${projectId}`);
    revalidatePath("/queue");
    return "Clips cancelled";
  });
}

export async function cancelAiVideoAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await cancelAiVideo({
      db: prisma,
      jobs: getAiVideoJobs(),
      interrupt: () => interruptComfy(),
      ownerId: await getOwnerId(),
      jobId: String(formData.get("jobId")),
    });
    revalidatePath("/clips");
    revalidatePath("/queue");
    return "AI video cancelled";
  });
}
