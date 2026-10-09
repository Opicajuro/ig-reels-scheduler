import { Queue, Worker } from "bullmq";
import { requireEnv } from "@/lib/env";
import { refreshDueTokens } from "@/lib/refresh-job";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";
import { INSIGHTS_QUEUE, MEDIA_QUEUE, PUBLISH_QUEUE, redisConnection } from "@/lib/queues";
import { processInsightsJob } from "./insights-processor";
import { processMedia } from "@/lib/media-jobs";
import { presignDownload, presignUpload } from "@/lib/storage";
import { createPublishProcessor } from "./publish-processor";
import { sendOwnerAlerts } from "@/lib/alert-job";
import { sendEmail } from "@/lib/alerts";
import Redis from "ioredis";

const QUEUE_NAME = "token-refresh";
const SCHEDULER_ID = "daily-token-refresh";
const DAILY_AT_03_UTC = "0 3 * * *";
const ALERTS_QUEUE = "owner-alerts";
const ALERTS_SCHEDULER_ID = "daily-owner-alerts";
const DAILY_AT_08_UTC = "0 8 * * *";
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

  const lockRedis = new Redis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
  new Worker(PUBLISH_QUEUE, createPublishProcessor(lockRedis), { connection });
  new Worker(INSIGHTS_QUEUE, processInsightsJob, { connection });

  const alertsQueue = new Queue(ALERTS_QUEUE, { connection });
  await alertsQueue.upsertJobScheduler(ALERTS_SCHEDULER_ID, { pattern: DAILY_AT_08_UTC }, { name: "alerts" });
  new Worker(
    ALERTS_QUEUE,
    async () => {
      await sendOwnerAlerts({ db: prisma, now: new Date(), send: sendEmail });
    },
    { connection },
  );

  console.log(`worker running: token refresh at ${DAILY_AT_03_UTC} UTC, media and publishing enabled`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
