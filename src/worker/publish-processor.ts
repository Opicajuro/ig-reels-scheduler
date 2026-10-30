import type { Job } from "pg-boss";
import { createAccountLock } from "@/lib/account-lock";
import { prisma } from "@/lib/prisma";
import { publishPost } from "@/lib/publish-job";
import * as metaPublish from "@/lib/meta-publish";
import { discardIgPostVideo, stageIgPostVideo } from "@/lib/r2";
import { openObject } from "@/lib/storage";
import { decryptToken, loadTokenKey } from "@/lib/token-crypto";
import { getInsightsQueue, getPublishQueue, PUBLISH_RETRY_LIMIT } from "@/lib/queues";
import { scheduleInsightPulls } from "@/lib/insights";

export async function accessTokenFor(accountId: string): Promise<string> {
  const row = await prisma.igToken.findUnique({ where: { accountId } });
  if (!row) throw new Error(`no token stored for account ${accountId}`);
  return decryptToken(
    { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag) },
    loadTokenKey(),
  );
}

// Ends this run without failing the job. The run that comes next is already queued.
class RunDeferred extends Error {}

export function createPublishProcessor() {
  const lock = createAccountLock(prisma);
  const queue = getPublishQueue();

  return async ([job]: Job<{ postId: string }>[]) => {
    try {
      const now = new Date();
      await publishPost({
        db: prisma,
        postId: job.data.postId,
        now,
        meta: metaPublish,
        stageVideo: (postId, reelKey) => stageIgPostVideo(prisma, openObject, postId, reelKey),
        discardVideo: (postId) => discardIgPostVideo(prisma, postId),
        getToken: accessTokenFor,
        lock,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // Section 7 step 5: run again at the given time by queueing a new job, not by sleeping.
        deferUntil: async (at) => {
          const queueJobId = await queue.send(job.data.postId, at);
          await prisma.post.update({ where: { id: job.data.postId }, data: { queueJobId } });
          throw new RunDeferred();
        },
      });

      const published = await prisma.post.findUnique({ where: { id: job.data.postId } });
      if (published?.status === "published") {
        await scheduleInsightPulls(getInsightsQueue(), { postId: published.id, publishedAt: now, now });
      }
    } catch (err) {
      if (err instanceof RunDeferred) return;
      // pg-boss retries until the last attempt. After that, record the failure so the post does not sit in a
      // non-terminal state with no explanation.
      const lastAttempt = job.retryCount >= PUBLISH_RETRY_LIMIT;
      if (lastAttempt) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.post.updateMany({
          where: { id: job.data.postId, status: { in: ["scheduled", "container_created"] } },
          data: { status: "failed", lastError: message, attempts: { increment: 1 } },
        });
        await discardIgPostVideo(prisma, job.data.postId);
      }
      throw err;
    }
  };
}
