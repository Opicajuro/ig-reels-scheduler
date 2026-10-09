import { DelayedError, type Job } from "bullmq";
import type Redis from "ioredis";
import { createAccountLock } from "@/lib/account-lock";
import { prisma } from "@/lib/prisma";
import { publishPost } from "@/lib/publish-job";
import * as metaPublish from "@/lib/meta-publish";
import { presignDownload } from "@/lib/storage";
import { decryptToken, loadTokenKey } from "@/lib/token-crypto";
import { getInsightsQueue } from "@/lib/queues";
import { scheduleInsightPulls } from "@/lib/insights";

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
    const post = await prisma.post.findUnique({ where: { id: job.data.postId } });
    if (!post) throw new Error(`post ${job.data.postId} not found`);

    // Section 7 step 5: wait until the publish time with a delayed re-enqueue, not a sleep.
    if (post.scheduledAt.getTime() > Date.now()) {
      await job.moveToDelayed(post.scheduledAt.getTime(), token);
      throw new DelayedError();
    }

    const now = new Date();
    await publishPost({
      db: prisma,
      postId: job.data.postId,
      now,
      meta: metaPublish,
      getReelUrl: (key) => presignDownload(key, DOWNLOAD_LIFETIME_SECONDS),
      getToken: accessTokenFor,
      lock,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    const published = await prisma.post.findUnique({ where: { id: job.data.postId } });
    if (published?.status === "published") {
      await scheduleInsightPulls(getInsightsQueue(), { postId: published.id, publishedAt: now, now });
    }
  };
}
