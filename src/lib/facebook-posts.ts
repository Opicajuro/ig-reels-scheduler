import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { UserError } from "./user-error";
import { youTubeJobRunAt } from "./youtube-posts";

// A Facebook Reel is uploaded and published at its publish time, or now if that has passed, like a YouTube Short.
export const facebookJobRunAt = youTubeJobRunAt;

// Only before the upload starts: a Reel Facebook already has is removed on the Page.
export async function cancelFacebookPost({
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
  const post = await db.fbPost.findFirst({ where: { id: postId, fbPage: { ownerId } } });
  if (!post) throw new UserError("post not found");
  if (post.status === "container_created") throw new UserError("the upload to Facebook has started; remove the Reel on the Page");
  if (post.status !== "scheduled") throw new UserError("post is not scheduled");
  // Conditional, so an upload that starts at this moment is not marked canceled.
  const { count } = await db.fbPost.updateMany({ where: { id: postId, status: "scheduled" }, data: { status: "canceled" } });
  if (count === 0) throw new UserError("the upload to Facebook has started; remove the Reel on the Page");
  if (post.queueJobId) await queue.cancel(post.queueJobId);
}

// Starts again from a new upload session: the failed one is not used again.
export async function retryFacebookPost({
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
  const post = await db.fbPost.findFirst({ where: { id: postId, fbPage: { ownerId } }, include: { fbPage: true } });
  if (!post) throw new UserError("post not found");
  if (post.status !== "failed") throw new UserError("only failed posts can be retried");
  if (post.fbPage.status !== "active") throw new UserError("reconnect the Facebook Page on the Accounts page first");

  await db.fbPost.update({ where: { id: postId }, data: { status: "scheduled", lastError: null, videoId: null, fbPostId: null } });
  const queueJobId = await queue.send(postId, facebookJobRunAt(post.scheduledAt, now));
  await db.fbPost.update({ where: { id: postId }, data: { queueJobId } });
}
