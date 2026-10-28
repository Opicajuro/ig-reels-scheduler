import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { UserError } from "./user-error";

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
  if (!post) throw new UserError("post is not scheduled");

  // container_created covers the 45 minutes before publish; the publish job checks for canceled before publishing.
  await db.post.update({ where: { id: postId }, data: { status: "canceled" } });
  if (post.queueJobId) await queue.cancel(post.queueJobId);
}
