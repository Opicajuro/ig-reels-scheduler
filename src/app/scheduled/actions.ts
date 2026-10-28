"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { cancelScheduledPost } from "@/lib/posts";
import { retryFailedPost } from "@/lib/post-retry";
import { getPublishQueue } from "@/lib/queues";

// The screens that show a post's status.
function revalidateScreens(postId: string) {
  revalidatePath("/");
  revalidatePath("/scheduled");
  revalidatePath(`/posts/${postId}`);
}

export async function retryPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await retryFailedPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: await getOwnerId(),
      postId,
      now: new Date(),
    });
    revalidateScreens(postId);
    return "Scheduled again";
  });
}

export async function cancelPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await cancelScheduledPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: await getOwnerId(),
      postId,
    });
    revalidateScreens(postId);
    return "Post canceled";
  });
}
