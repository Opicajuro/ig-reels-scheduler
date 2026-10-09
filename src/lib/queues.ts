import { Queue } from "bullmq";
import { requireEnv } from "./env";

export const MEDIA_QUEUE = "media-process";

export function redisConnection() {
  const url = new URL(requireEnv("REDIS_URL"));
  return { host: url.hostname, port: Number(url.port || 6379) };
}

export const PUBLISH_QUEUE = "publish";
export const INSIGHTS_QUEUE = "insights";

let mediaQueue: Queue | undefined;
let publishQueue: Queue | undefined;
let insightsQueue: Queue | undefined;

export function getInsightsQueue(): Queue {
  insightsQueue ??= new Queue(INSIGHTS_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
  });
  return insightsQueue;
}

export function enqueueMediaProcess(mediaId: string) {
  mediaQueue ??= new Queue(MEDIA_QUEUE, { connection: redisConnection() });
  return mediaQueue.add("process", { mediaId }, { jobId: mediaId });
}

export function getPublishQueue(): Queue {
  // Finished jobs are removed so a manual retry can queue the same post id again.
  publishQueue ??= new Queue(PUBLISH_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });
  return publishQueue;
}
