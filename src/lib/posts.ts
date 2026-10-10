import type { PrismaClient } from "@/generated/prisma/client";
import { validateCaption } from "./caption";
import type { PublishQueue } from "./queues";
import { schedulePost } from "./scheduling";

export type PostInput = {
  accountId: string;
  mediaId: string;
  caption: string;
  scheduledAt: string;
  shareToFeed?: boolean;
  /** the operator confirmed they own or license the video and its audio; no post is created without it */
  rightsConfirmed: boolean;
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
  if (input.rightsConfirmed !== true) {
    throw new Error("Please confirm you own or hold a license to this video and its audio before scheduling.");
  }
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
      rightsConfirmedAt: now,
    },
  });
  await schedulePost(db, queue, { id: post.id, scheduledAt }, now);
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
    where: { id: postId, status: { in: ["scheduled", "container_created"] }, account: { ownerId } },
  });
  if (!post) throw new Error("post is not scheduled");

  // container_created covers the 45 minutes before publish; the publish job checks for canceled before publishing.
  await db.post.update({ where: { id: postId }, data: { status: "canceled" } });
  if (post.queueJobId) await queue.cancel(post.queueJobId);
}
