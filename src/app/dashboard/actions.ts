"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { cancelScheduledPost } from "@/lib/posts";
import { retryFailedPost } from "@/lib/post-retry";
import { getPublishQueue } from "@/lib/queues";

export async function retryPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await retryFailedPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: await getOwnerId(),
      postId: String(formData.get("postId")),
      now: new Date(),
    });
    revalidatePath("/dashboard");
    return "Scheduled again";
  });
}

export async function cancelPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await cancelScheduledPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: await getOwnerId(),
      postId: String(formData.get("postId")),
    });
    revalidatePath("/dashboard");
    return "Post canceled";
  });
}
