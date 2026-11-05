"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { cancelScheduledPost } from "@/lib/posts";
import { retryFailedPost } from "@/lib/post-retry";
import { getFacebookPublishQueue, getPublishQueue, getTikTokPublishQueue, getYouTubePublishQueue } from "@/lib/queues";
import { cancelFacebookPost, retryFacebookPost } from "@/lib/facebook-posts";
import { cancelTikTokPost, retryTikTokPost } from "@/lib/tiktok-posts";
import { cancelYouTubePost, retryYouTubePost } from "@/lib/youtube-posts";

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

export async function retryYouTubePostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await retryYouTubePost({
      db: prisma,
      queue: getYouTubePublishQueue(),
      ownerId: await getOwnerId(),
      postId,
      now: new Date(),
    });
    revalidateScreens(postId);
    return "Scheduled again";
  });
}

export async function cancelYouTubePostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await cancelYouTubePost({ db: prisma, queue: getYouTubePublishQueue(), ownerId: await getOwnerId(), postId });
    revalidateScreens(postId);
    return "Post canceled";
  });
}

export async function retryFacebookPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await retryFacebookPost({ db: prisma, queue: getFacebookPublishQueue(), ownerId: await getOwnerId(), postId, now: new Date() });
    revalidateScreens(postId);
    return "Scheduled again";
  });
}

export async function cancelFacebookPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await cancelFacebookPost({ db: prisma, queue: getFacebookPublishQueue(), ownerId: await getOwnerId(), postId });
    revalidateScreens(postId);
    return "Post canceled";
  });
}

export async function retryTikTokPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await retryTikTokPost({ db: prisma, queue: getTikTokPublishQueue(), ownerId: await getOwnerId(), postId, now: new Date() });
    revalidateScreens(postId);
    return "Scheduled again";
  });
}

export async function cancelTikTokPostAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const postId = String(formData.get("postId"));
    await cancelTikTokPost({ db: prisma, queue: getTikTokPublishQueue(), ownerId: await getOwnerId(), postId });
    revalidateScreens(postId);
    return "Post canceled";
  });
}
