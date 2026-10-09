import { Queue, Worker } from "bullmq";
import { requireEnv } from "@/lib/env";
import { refreshDueTokens } from "@/lib/refresh-job";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";

const QUEUE_NAME = "token-refresh";
const SCHEDULER_ID = "daily-token-refresh";
const DAILY_AT_03_UTC = "0 3 * * *";

async function main() {
  const redis = new URL(requireEnv("REDIS_URL"));
  const connection = {
    host: redis.hostname,
    port: Number(redis.port || 6379),
  };

  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.upsertJobScheduler(SCHEDULER_ID, { pattern: DAILY_AT_03_UTC }, { name: "refresh" });

  new Worker(
    QUEUE_NAME,
    async () => {
      await refreshDueTokens(prisma, { now: new Date(), key: loadTokenKey() });
    },
    { connection },
  );

  console.log(`token-refresh worker running, scheduled ${DAILY_AT_03_UTC} UTC`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
