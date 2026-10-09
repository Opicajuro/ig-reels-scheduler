import type { PrismaClient } from "@/generated/prisma/client";
import { validateCaption } from "./caption";
import { cancelPost, schedulePost, type PublishQueue } from "./scheduling";

export type PostInput = {
  accountId: string;
  mediaId: string;
  caption: string;
  scheduledAt: string;
  shareToFeed?: boolean;
};

export async function createScheduledPost({
  db,
  queue,
  ownerId,
  input,
  now,
}: {
  db: PrismaClient;
  queue: PublishQueue;
  ownerId: string;
  input: PostInput;
  now: Date;
}) {
  const problems = validateCaption(input.caption);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const scheduledAt = new Date(input.scheduledAt);
  if (!(scheduledAt.getTime() > now.getTime())) throw new Error("scheduledAt must be in the future");

  const media = await db.media.findFirst({
    where: { id: input.mediaId, status: "ready", account: { id: input.accountId, ownerId } },
  });
  if (!media) throw new Error("media is not ready for this account");

  const post = await db.post.create({
    data: {
      accountId: input.accountId,
      mediaId: input.mediaId,
      caption: input.caption,
      shareToFeed: input.shareToFeed ?? true,
      scheduledAt,
    },
  });
  await schedulePost(queue, { id: post.id, scheduledAt }, now);
  return post;
}

export async function cancelScheduledPost({
  db,
  queue,
  ownerId,
  postId,
}: {
  db: PrismaClient;
  queue: PublishQueue;
  ownerId: string;
  postId: string;
}) {
  const post = await db.post.findFirst({
    where: { id: postId, status: "scheduled", account: { ownerId } },
  });
  if (!post) throw new Error("post is not scheduled");

  await db.post.update({ where: { id: postId }, data: { status: "canceled" } });
  await cancelPost(queue, postId);
}
