import type { Job } from "pg-boss";
import { requireEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { getTikTokPublishQueue, PUBLISH_RETRY_LIMIT } from "@/lib/queues";
import { getSettings } from "@/lib/settings";
import { objectSize, readObjectRange } from "@/lib/storage";
import { describeTikTokError, tikTokAppConfig } from "@/lib/tiktok";
import { tikTokAccessToken } from "@/lib/tiktok-accounts";
import { publishTikTokPost } from "@/lib/tiktok-publish-job";
import { loadTokenKey } from "@/lib/token-crypto";

// Settings are read at each use, so an app saved on /settings applies at once.
async function accessTokenFor(ttAccountId: string): Promise<string> {
  const app = tikTokAppConfig(await getSettings(prisma), requireEnv("APP_URL"));
  if (!app) throw new Error("TikTok is not set up: add your TikTok app on the Settings page");
  return tikTokAccessToken({ db: prisma, key: loadTokenKey(), app, ttAccountId, now: new Date() });
}

class RunDeferred extends Error {}

export function createTikTokPublishProcessor() {
  const queue = getTikTokPublishQueue();
  return async ([job]: Job<{ postId: string }>[]) => {
    const { postId } = job.data;
    try {
      await publishTikTokPost({
        db: prisma,
        postId,
        now: new Date(),
        getAccessToken: accessTokenFor,
        openVideo: async (key) => ({ size: await objectSize(key), read: (start, end) => readObjectRange(key, start, end) }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        deferUntil: async (at) => {
          const queueJobId = await queue.send(postId, at);
          await prisma.ttPost.update({ where: { id: postId }, data: { queueJobId } });
          throw new RunDeferred();
        },
      });
    } catch (err) {
      if (err instanceof RunDeferred) return;
      if (job.retryCount >= PUBLISH_RETRY_LIMIT) {
        await prisma.ttPost.updateMany({
          where: { id: postId, status: { in: ["scheduled", "container_created"] } },
          data: { status: "failed", lastError: describeTikTokError(err), attempts: { increment: 1 } },
        });
      }
      throw err;
    }
  };
}
