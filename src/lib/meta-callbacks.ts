import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";
import { discardIgPostVideo } from "./r2";

// Cancels the account's scheduled posts and removes their publish jobs, so nothing is left queued for a revoked account.
async function cancelScheduledPosts(db: PrismaClient, queue: PublishQueue, igUserId: string) {
  const scheduled = await db.post.findMany({
    where: { account: { igUserId }, status: { in: ["scheduled", "container_created"] } },
    select: { id: true, queueJobId: true },
  });
  await db.post.updateMany({
    where: { id: { in: scheduled.map((post) => post.id) } },
    data: { status: "canceled" },
  });
  for (const post of scheduled) {
    if (post.queueJobId) await queue.cancel(post.queueJobId);
    await discardIgPostVideo(db, post.id);
  }
}

export async function revokeAccount(db: PrismaClient, queue: PublishQueue, igUserId: string) {
  await db.igAccount.updateMany({
    where: { igUserId },
    data: { status: "revoked" },
  });
  await cancelScheduledPosts(db, queue, igUserId);
}

// Deletes the account's stored files first, so a failed delete can be retried while the rows still exist.
export async function purgeUserData(
  db: PrismaClient,
  queue: PublishQueue,
  deleteObject: (key: string) => Promise<void>,
  igUserId: string,
) {
  const media = await db.media.findMany({
    where: { account: { igUserId } },
    select: { rawKey: true, reelKey: true, coverKey: true },
  });
  for (const item of media) {
    for (const key of [item.rawKey, item.reelKey, item.coverKey]) {
      if (key) await deleteObject(key);
    }
  }
  await cancelScheduledPosts(db, queue, igUserId);
  await db.igAccount.deleteMany({ where: { igUserId } });
}
