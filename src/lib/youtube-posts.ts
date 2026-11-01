import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { UserError } from "./user-error";

// A YouTube post is uploaded at its publish time, or now if that has passed: the upload is the publish.
export function youTubeJobRunAt(scheduledAt: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), scheduledAt.getTime()));
}

// Only before the upload starts: a video YouTube already has is removed in YouTube Studio.
export async function cancelYouTubePost({
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
  const post = await db.ytPost.findFirst({ where: { id: postId, ytAccount: { ownerId } } });
  if (!post) throw new UserError("post not found");
  if (post.status === "container_created") throw new UserError("the upload to YouTube has started; remove the video in YouTube Studio");
  if (post.status !== "scheduled") throw new UserError("post is not scheduled");
  // Conditional, so an upload that starts at this moment is not marked canceled.
  const { count } = await db.ytPost.updateMany({ where: { id: postId, status: "scheduled" }, data: { status: "canceled" } });
  if (count === 0) throw new UserError("the upload to YouTube has started; remove the video in YouTube Studio");
  if (post.queueJobId) await queue.cancel(post.queueJobId);
}

export async function retryYouTubePost({
  db,
  queue,
  ownerId,
  postId,
  now,
}: {
  db: PrismaClient;
  queue: PublishQueue;
  ownerId: string;
  postId: string;
  now: Date;
}) {
  const post = await db.ytPost.findFirst({ where: { id: postId, ytAccount: { ownerId } }, include: { ytAccount: true } });
  if (!post) throw new UserError("post not found");
  if (post.status !== "failed") throw new UserError("only failed posts can be retried");
  if (post.ytAccount.status !== "active") throw new UserError("reconnect the YouTube channel on the Accounts page first");

  await db.ytPost.update({ where: { id: postId }, data: { status: "scheduled", lastError: null } });
  const queueJobId = await queue.send(postId, youTubeJobRunAt(post.scheduledAt, now));
  await db.ytPost.update({ where: { id: postId }, data: { queueJobId } });
}
