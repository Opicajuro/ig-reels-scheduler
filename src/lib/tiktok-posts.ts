import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { UserError } from "./user-error";
import { youTubeJobRunAt } from "./youtube-posts";

// A TikTok draft is uploaded at its publish time, or now if that has passed, like a YouTube Short.
export const tikTokJobRunAt = youTubeJobRunAt;

// Only before the upload starts: a draft TikTok already has is deleted in the TikTok app.
export async function cancelTikTokPost({
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
  const post = await db.ttPost.findFirst({ where: { id: postId, ttAccount: { ownerId } } });
  if (!post) throw new UserError("post not found");
  if (post.status === "container_created") throw new UserError("the upload to TikTok has started; delete the draft in the TikTok app");
  if (post.status !== "scheduled") throw new UserError("post is not scheduled");
  // Conditional, so an upload that starts at this moment is not marked canceled.
  const { count } = await db.ttPost.updateMany({ where: { id: postId, status: "scheduled" }, data: { status: "canceled" } });
  if (count === 0) throw new UserError("the upload to TikTok has started; delete the draft in the TikTok app");
  if (post.queueJobId) await queue.cancel(post.queueJobId);
}

// Starts again with a new upload: the failed one is not used again.
export async function retryTikTokPost({
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
  const post = await db.ttPost.findFirst({ where: { id: postId, ttAccount: { ownerId } }, include: { ttAccount: true } });
  if (!post) throw new UserError("post not found");
  if (post.status !== "failed") throw new UserError("only failed posts can be retried");
  if (post.ttAccount.status !== "active") throw new UserError("reconnect the TikTok account on the Accounts page first");

  await db.ttPost.update({ where: { id: postId }, data: { status: "scheduled", lastError: null, publishId: null, uploadUrl: null } });
  const queueJobId = await queue.send(postId, tikTokJobRunAt(post.scheduledAt, now));
  await db.ttPost.update({ where: { id: postId }, data: { queueJobId } });
}
