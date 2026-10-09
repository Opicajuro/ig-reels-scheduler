import { Queue } from "bullmq";
import { requireEnv } from "./env";

export const MEDIA_QUEUE = "media-process";

export function redisConnection() {
  const url = new URL(requireEnv("REDIS_URL"));
  return { host: url.hostname, port: Number(url.port || 6379) };
}

let mediaQueue: Queue | undefined;

export function enqueueMediaProcess(mediaId: string) {
  mediaQueue ??= new Queue(MEDIA_QUEUE, { connection: redisConnection() });
  return mediaQueue.add("process", { mediaId }, { jobId: mediaId });
}
