import { DelayedError, type Job } from "bullmq";
import type Redis from "ioredis";
import { createAccountLock } from "@/lib/account-lock";
import { prisma } from "@/lib/prisma";
import { publishPost } from "@/lib/publish-job";
import * as metaPublish from "@/lib/meta-publish";
import { presignDownload } from "@/lib/storage";
import { decryptToken, loadTokenKey } from "@/lib/token-crypto";

const DOWNLOAD_LIFETIME_SECONDS = 7200;

export async function accessTokenFor(accountId: string): Promise<string> {
  const row = await prisma.igToken.findUnique({ where: { accountId } });
  if (!row) throw new Error(`no token stored for account ${accountId}`);
  return decryptToken(
    { ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv), authTag: Buffer.from(row.authTag) },
    loadTokenKey(),
  );
}

export function createPublishProcessor(redis: Redis) {
  const lock = createAccountLock(redis);

  return async (job: Job<{ postId: string }>, token?: string) => {
    try {
      await publishPost({
        db: prisma,
        postId: job.data.postId,
        now: new Date(),
        meta: metaPublish,
        getReelUrl: (key) => presignDownload(key, DOWNLOAD_LIFETIME_SECONDS),
        getToken: accessTokenFor,
        lock,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        // Section 7 step 5: run again at the given time with a delayed re-enqueue, not a sleep.
        deferUntil: async (at) => {
          await job.moveToDelayed(at.getTime(), token);
          throw new DelayedError();
        },
      });
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      // BullMQ retries until the last attempt. After that, record the failure so the post does not sit in a
      // non-terminal state with no explanation.
      const lastAttempt = job.attemptsStarted >= (job.opts.attempts ?? 1);
      if (lastAttempt) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.post.updateMany({
          where: { id: job.data.postId, status: { in: ["scheduled", "container_created"] } },
          data: { status: "failed", lastError: message, attempts: { increment: 1 } },
        });
      }
      throw err;
    }
  };
}
