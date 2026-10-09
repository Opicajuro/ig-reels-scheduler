import { Queue, Worker } from "bullmq";
import { requireEnv } from "@/lib/env";
import { refreshDueTokens } from "@/lib/refresh-job";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";
import { MEDIA_QUEUE, redisConnection } from "@/lib/queues";
import { processMedia } from "@/lib/media-jobs";
import { presignDownload, presignUpload } from "@/lib/storage";

const QUEUE_NAME = "token-refresh";
const SCHEDULER_ID = "daily-token-refresh";
const DAILY_AT_03_UTC = "0 3 * * *";
const DOWNLOAD_LIFETIME_SECONDS = 7200;

async function main() {
  const connection = redisConnection();

  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler(SCHEDULER_ID, { pattern: DAILY_AT_03_UTC }, { name: "refresh" });

  new Worker(
    QUEUE_NAME,
    async () => {
      await refreshDueTokens(prisma, { now: new Date(), key: loadTokenKey() });
    },
    { connection },
  );

  new Worker(
    MEDIA_QUEUE,
    async (job) => {
      await processMedia({
        db: prisma,
        mediaId: job.data.mediaId as string,
        fetchFn: fetch,
        getDownloadUrl: (key) => presignDownload(key, DOWNLOAD_LIFETIME_SECONDS),
        getUploadUrl: (key, contentType) => presignUpload(key, contentType),
      });
    },
    { connection },
  );

  console.log(`worker running: token refresh at ${DAILY_AT_03_UTC} UTC, media processing enabled`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
