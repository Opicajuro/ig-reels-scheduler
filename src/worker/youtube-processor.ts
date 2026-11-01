import type { Job } from "pg-boss";
import { requireEnv } from "@/lib/env";
import { scheduleInsightPulls } from "@/lib/insights";
import { prisma } from "@/lib/prisma";
import { getYouTubePublishQueue, getYouTubeStatsQueue, PUBLISH_RETRY_LIMIT } from "@/lib/queues";
import { getSettings } from "@/lib/settings";
import { objectSize, readObjectRange } from "@/lib/storage";
import { loadTokenKey } from "@/lib/token-crypto";
import { describeYouTubeError, getVideoStatistics, youTubeAppConfig } from "@/lib/youtube";
import { youTubeAccessToken } from "@/lib/youtube-accounts";
import { publishYouTubePost } from "@/lib/youtube-publish-job";

// Settings are read at each use, so a client saved on /settings applies at once.
async function accessTokenFor(ytAccountId: string): Promise<string> {
  const client = youTubeAppConfig(await getSettings(prisma), requireEnv("APP_URL"));
  if (!client) throw new Error("YouTube is not set up: add the Google OAuth client on the Settings page");
  return youTubeAccessToken({ db: prisma, key: loadTokenKey(), client, ytAccountId });
}

class RunDeferred extends Error {}

export function createYouTubePublishProcessor() {
  const queue = getYouTubePublishQueue();
  return async ([job]: Job<{ postId: string }>[]) => {
    const { postId } = job.data;
    try {
      const now = new Date();
      const published = await publishYouTubePost({
        db: prisma,
        postId,
        now,
        getAccessToken: accessTokenFor,
        openVideo: async (key) => ({ size: await objectSize(key), read: (start, end) => readObjectRange(key, start, end) }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        deferUntil: async (at) => {
          const queueJobId = await queue.send(postId, at);
          await prisma.ytPost.update({ where: { id: postId }, data: { queueJobId } });
          throw new RunDeferred();
        },
      });
      if (published) await scheduleInsightPulls(getYouTubeStatsQueue(), { postId, publishedAt: now, now });
    } catch (err) {
      if (err instanceof RunDeferred) return;
      // After the last retry, the post is marked failed so it does not stay "Publishing" with no explanation.
      if (job.retryCount >= PUBLISH_RETRY_LIMIT) {
        await prisma.ytPost.updateMany({
          where: { id: postId, status: { in: ["scheduled", "container_created"] } },
          data: { status: "failed", lastError: describeYouTubeError(err), attempts: { increment: 1 } },
        });
      }
      throw err;
    }
  };
}

export async function processYouTubeStatsJob([job]: Job<{ postId: string }>[]) {
  const post = await prisma.ytPost.findUnique({ where: { id: job.data.postId } });
  if (!post?.videoId) throw new Error(`YouTube post ${job.data.postId} has no video`);
  const metrics = await getVideoStatistics({ accessToken: await accessTokenFor(post.ytAccountId), videoId: post.videoId });
  const fetchedAt = new Date();
  await prisma.ytInsight.createMany({ data: metrics.map((metric) => ({ ytPostId: post.id, ...metric, fetchedAt })) });
}
