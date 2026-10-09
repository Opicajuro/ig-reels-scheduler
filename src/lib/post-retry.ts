import type { PrismaClient } from "@/generated/prisma/client";
import { schedulePost, type PublishQueue } from "./scheduling";

export async function retryFailedPost({
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
  const post = await db.post.findFirst({ where: { id: postId, account: { ownerId } } });
  if (!post) throw new Error("post not found");
  if (post.status !== "failed") throw new Error("only failed posts can be retried");

  // A failed container cannot be reused, so the next run creates a new one.
  await db.post.update({
    where: { id: postId },
    data: { status: "scheduled", lastError: null, containerId: null },
  });
  await schedulePost(queue, { id: postId, scheduledAt: post.scheduledAt }, now);
}
