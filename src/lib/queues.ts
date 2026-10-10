import { PgBoss } from "pg-boss";
import { requireEnv } from "./env";

export const MEDIA_QUEUE = "media-process";
export const PUBLISH_QUEUE = "publish";
export const INSIGHTS_QUEUE = "insights";
export const TOKEN_REFRESH_QUEUE = "token-refresh";
export const OWNER_ALERTS_QUEUE = "owner-alerts";
export const CLIP_QUEUE = "clip-project";

// A publish job runs up to 5 times: the first try, then 4 retries 60 seconds apart, doubling each time.
export const PUBLISH_RETRY_LIMIT = 4;
const PUBLISH_JOB_OPTIONS = { retryLimit: PUBLISH_RETRY_LIMIT, retryDelay: 60, retryBackoff: true };
const INSIGHT_JOB_OPTIONS = { retryLimit: 2, retryDelay: 60, retryBackoff: true };

export type PublishQueue = {
  send(postId: string, runAt: Date): Promise<string>;
  cancel(jobId: string): Promise<void>;
};

export type ClipQueue = {
  send(projectId: string): Promise<string>;
};

export type InsightQueue = {
  send(postId: string, label: string, runAt: Date): Promise<string | null>;
};

let boss: Promise<PgBoss> | undefined;

// One pg-boss instance per process, shared by the web app and the worker. The first start creates its tables
// in the app's database. A failed start is not cached, so the next call tries again.
export function getBoss(): Promise<PgBoss> {
  boss ??= startBoss().catch((err) => {
    boss = undefined;
    throw err;
  });
  return boss;
}

async function startBoss(): Promise<PgBoss> {
  const instance = new PgBoss({ connectionString: requireEnv("DATABASE_URL") });
  instance.on("error", (err) => console.error("pg-boss error:", err));
  await instance.start();
  // Media and insight jobs always carry a singletonKey. The "short" policy keeps one queued job per key, so a
  // repeat of the same job is ignored until the first one has run.
  const keyed = { policy: "short" as const };
  await instance.createQueue(MEDIA_QUEUE, keyed);
  await instance.createQueue(INSIGHTS_QUEUE, keyed);
  for (const name of [PUBLISH_QUEUE, TOKEN_REFRESH_QUEUE, OWNER_ALERTS_QUEUE, CLIP_QUEUE]) {
    await instance.createQueue(name);
  }
  return instance;
}

export function getPublishQueue(): PublishQueue {
  return {
    async send(postId, runAt) {
      const jobId = await (await getBoss()).sendAfter(PUBLISH_QUEUE, { postId }, PUBLISH_JOB_OPTIONS, runAt);
      if (jobId === null) throw new Error(`publish job for post ${postId} was not queued`);
      return jobId;
    },
    async cancel(jobId) {
      await (await getBoss()).cancel(PUBLISH_QUEUE, jobId);
    },
  };
}

// Rendering a long video can take hours, and pg-boss expires a job after 15 minutes by default. A render gets 6 hours.
// It is not retried: a failed render is recorded on the project, and the person starts it again.
export function getClipQueue(): ClipQueue {
  return {
    async send(projectId) {
      const jobId = await (await getBoss()).send(CLIP_QUEUE, { projectId }, { retryLimit: 0, expireInSeconds: 6 * 60 * 60 });
      if (jobId === null) throw new Error(`clip job for project ${projectId} was not queued`);
      return jobId;
    },
  };
}

export function getInsightsQueue(): InsightQueue {
  return {
    async send(postId, label, runAt) {
      return (await getBoss()).sendAfter(
        INSIGHTS_QUEUE,
        { postId },
        { ...INSIGHT_JOB_OPTIONS, singletonKey: `${postId}:${label}` },
        runAt,
      );
    },
  };
}

export async function enqueueMediaProcess(mediaId: string) {
  return (await getBoss()).send(MEDIA_QUEUE, { mediaId }, { singletonKey: mediaId });
}
