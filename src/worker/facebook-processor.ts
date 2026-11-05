import type { Job } from "pg-boss";
import { describeFacebookError } from "@/lib/facebook";
import { facebookPageToken } from "@/lib/facebook-accounts";
import { publishFacebookPost } from "@/lib/facebook-publish-job";
import { prisma } from "@/lib/prisma";
import { getFacebookPublishQueue, PUBLISH_RETRY_LIMIT } from "@/lib/queues";
import { discardFbPostVideo, stageFbPostVideo } from "@/lib/r2";
import { objectSize, openObject, readObjectRange } from "@/lib/storage";
import { loadTokenKey } from "@/lib/token-crypto";

class RunDeferred extends Error {}

export function createFacebookPublishProcessor() {
  const queue = getFacebookPublishQueue();
  return async ([job]: Job<{ postId: string }>[]) => {
    const { postId } = job.data;
    try {
      await publishFacebookPost({
        db: prisma,
        postId,
        now: new Date(),
        getPageToken: (fbPageId) => facebookPageToken({ db: prisma, key: loadTokenKey(), fbPageId }),
        stageVideo: (id, videoKey) => stageFbPostVideo(prisma, openObject, id, videoKey),
        discardVideo: (id) => discardFbPostVideo(prisma, id),
        openVideo: async (key) => ({ size: await objectSize(key), read: (start, end) => readObjectRange(key, start, end) }),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        deferUntil: async (at) => {
          const queueJobId = await queue.send(postId, at);
          await prisma.fbPost.update({ where: { id: postId }, data: { queueJobId } });
          throw new RunDeferred();
        },
      });
    } catch (err) {
      if (err instanceof RunDeferred) return;
      // After the last retry, the post is marked failed so it does not stay "Publishing" with no explanation.
      if (job.retryCount >= PUBLISH_RETRY_LIMIT) {
        await prisma.fbPost.updateMany({
          where: { id: postId, status: { in: ["scheduled", "container_created"] } },
          data: { status: "failed", lastError: describeFacebookError(err), attempts: { increment: 1 } },
        });
        await discardFbPostVideo(prisma, postId);
      }
      throw err;
    }
  };
}
