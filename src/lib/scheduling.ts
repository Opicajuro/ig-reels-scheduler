import type { PrismaClient } from "@/generated/prisma/client";
import type { PublishQueue } from "./queues";

const LEAD_TIME_MS = 45 * 60 * 1000;

// Queues the post to start 45 minutes before it is due, or now if that moment has passed. The job id is stored on
// the post so that cancelling can remove the job.
export async function schedulePost(
  db: PrismaClient,
  queue: PublishQueue,
  post: { id: string; scheduledAt: Date },
  now: Date,
) {
  const runAt = new Date(Math.max(now.getTime(), post.scheduledAt.getTime() - LEAD_TIME_MS));
  const queueJobId = await queue.send(post.id, runAt);
  await db.post.update({ where: { id: post.id }, data: { queueJobId } });
}
