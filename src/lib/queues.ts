import { PgBoss } from "pg-boss";
import type { AiEngineQueue } from "./ai-engine";
import type { AiVideoQueue } from "./ai-video";
import type { ClipWriterQueue } from "./clip-writer";
import type { SlideshowQueue } from "./slideshow";
import type { SlideshowEngineQueue } from "./slideshow-engines";
import { requireEnv } from "./env";

export const MEDIA_QUEUE = "media-process";
export const PUBLISH_QUEUE = "publish";
export const INSIGHTS_QUEUE = "insights";
export const TOKEN_REFRESH_QUEUE = "token-refresh";
export const OWNER_ALERTS_QUEUE = "owner-alerts";
export const CLIP_QUEUE = "clip-project";
export const CLIP_RECAPTION_QUEUE = "clip-recaption";
export const CLIP_WRITER_QUEUE = "clip-writer";
export const AI_ENGINE_QUEUE = "ai-engine";
export const AI_VIDEO_QUEUE = "ai-video";
export const BACKUP_QUEUE = "backup";
export const SLIDESHOW_ENGINE_QUEUE = "slideshow-engine";
export const SLIDESHOW_QUEUE = "slideshow";
export const YOUTUBE_PUBLISH_QUEUE = "youtube-publish";
export const YOUTUBE_STATS_QUEUE = "youtube-stats";

// A publish job runs up to 5 times: the first try, then 4 retries 60 seconds apart, doubling each time.
export const PUBLISH_RETRY_LIMIT = 4;
const PUBLISH_JOB_OPTIONS = { retryLimit: PUBLISH_RETRY_LIMIT, retryDelay: 60, retryBackoff: true };
const INSIGHT_JOB_OPTIONS = { retryLimit: 2, retryDelay: 60, retryBackoff: true };

export type PublishQueue = {
  send(postId: string, runAt: Date): Promise<string>;
  cancel(jobId: string): Promise<void>;
};

export type ClipQueue = {
  send(projectId: string, renderId: string): Promise<string>;
};

export type ClipJob = { id: string; state: "created" | "retry" | "active"; renderId: unknown };

// What the worker needs at start-up to queue again the renders that were interrupted.
export type ClipJobs = ClipQueue & {
  // The project's clip jobs that are waiting or marked as running.
  open(projectId: string): Promise<ClipJob[]>;
  cancel(jobIds: string[]): Promise<void>;
};

// An AI video's or a slideshow's pg-boss jobs, for cancelling it from the Queue page.
export type WorkJobs = {
  // The ids of its jobs that are waiting or marked as running.
  open(id: string): Promise<string[]>;
  cancel(jobIds: string[]): Promise<void>;
};

// The worker also asks, when it starts, which of them are still waiting to be taken.
export type StartupWorkJobs = WorkJobs & {
  waiting(id: string): Promise<string[]>;
};

// Drawing one clip's captions again from its edited words.
export type RecaptionQueue = {
  send(clipId: string, recaptionId: string): Promise<string>;
};
export type RecaptionJobs = RecaptionQueue & WorkJobs;

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
  await instance.createQueue(YOUTUBE_STATS_QUEUE, keyed);
  for (const name of [PUBLISH_QUEUE, YOUTUBE_PUBLISH_QUEUE, TOKEN_REFRESH_QUEUE, OWNER_ALERTS_QUEUE, CLIP_QUEUE, CLIP_RECAPTION_QUEUE, CLIP_WRITER_QUEUE, AI_ENGINE_QUEUE, AI_VIDEO_QUEUE, BACKUP_QUEUE, SLIDESHOW_ENGINE_QUEUE, SLIDESHOW_QUEUE]) {
    await instance.createQueue(name);
  }
  return instance;
}

function publishQueue(name: string): PublishQueue {
  return {
    async send(postId, runAt) {
      const jobId = await (await getBoss()).sendAfter(name, { postId }, PUBLISH_JOB_OPTIONS, runAt);
      if (jobId === null) throw new Error(`${name} job for post ${postId} was not queued`);
      return jobId;
    },
    async cancel(jobId) {
      await (await getBoss()).cancel(name, jobId);
    },
  };
}

export function getPublishQueue(): PublishQueue {
  return publishQueue(PUBLISH_QUEUE);
}

// The same retries as Instagram's: a 5xx that outlasts the upload's own retries is tried again a minute later, then
// 2, 4 and 8 minutes after that, each going on from the stored upload session.
export function getYouTubePublishQueue(): PublishQueue {
  return publishQueue(YOUTUBE_PUBLISH_QUEUE);
}

// Rendering a long video can take hours, and pg-boss expires a job after 15 minutes by default. A render gets 6 hours.
// It is not retried: a failed render is recorded on the project, and the person starts it again. A render cut off by
// closing Localirs is queued again when the worker starts (requeueInterruptedRenders), not by a pg-boss retry, which
// would wait out the 6 hours.
export function getClipQueue(): ClipQueue {
  return {
    async send(projectId, renderId) {
      const jobId = await (await getBoss()).send(CLIP_QUEUE, { projectId, renderId }, { retryLimit: 0, expireInSeconds: 6 * 60 * 60 });
      if (jobId === null) throw new Error(`clip job for project ${projectId} was not queued`);
      return jobId;
    },
  };
}

export function getClipJobs(): ClipJobs {
  return {
    ...getClipQueue(),
    async open(projectId) {
      const jobs = await (await getBoss()).findJobs<{ renderId?: unknown }>(CLIP_QUEUE, { data: { projectId } });
      return jobs.flatMap((job) =>
        job.state === "created" || job.state === "retry" || job.state === "active"
          ? [{ id: job.id, state: job.state, renderId: job.data.renderId }]
          : [],
      );
    },
    async cancel(jobIds) {
      await (await getBoss()).cancel(CLIP_QUEUE, jobIds);
    },
  };
}

// Installing the AI engine downloads about 20 GB, which can take many hours on a slow line; it gets a day. A video
// takes minutes on a 16 GB card, and much longer the first time Windows reads the model files; it gets 2 hours.
// Neither is retried: the failure is shown on the Clips page or in Settings, and the person starts it again.
export function getAiEngineQueue(): AiEngineQueue {
  return {
    async send() {
      const jobId = await (await getBoss()).send(AI_ENGINE_QUEUE, {}, { retryLimit: 0, expireInSeconds: 24 * 60 * 60 });
      if (jobId === null) throw new Error("the AI engine install was not queued");
      return jobId;
    },
  };
}

export function getAiVideoQueue(): AiVideoQueue {
  return {
    async send(aiVideoJobId) {
      const jobId = await (await getBoss()).send(AI_VIDEO_QUEUE, { aiVideoJobId }, { retryLimit: 0, expireInSeconds: 2 * 60 * 60 });
      if (jobId === null) throw new Error(`AI video job ${aiVideoJobId} was not queued`);
      return jobId;
    },
  };
}

// The open jobs of one queue whose data carries the id under key.
function workJobs(queue: string, key: string): StartupWorkJobs {
  return {
    async open(id) {
      const jobs = await (await getBoss()).findJobs(queue, { data: { [key]: id } });
      return jobs.flatMap((job) => (job.state === "created" || job.state === "retry" || job.state === "active" ? [job.id] : []));
    },
    async waiting(id) {
      const jobs = await (await getBoss()).findJobs(queue, { data: { [key]: id } });
      return jobs.flatMap((job) => (job.state === "created" || job.state === "retry" ? [job.id] : []));
    },
    async cancel(jobIds) {
      await (await getBoss()).cancel(queue, jobIds);
    },
  };
}

export function getAiVideoJobs(): StartupWorkJobs {
  return workJobs(AI_VIDEO_QUEUE, "aiVideoJobId");
}

// One clip's captions take a minute or two; it gets half an hour. It is not retried: the failure is shown in the clip's
// Captions tab. One cut off by closing Localirs is queued again when the worker starts (requeueInterruptedRecaptions).
export function getRecaptionJobs(): RecaptionJobs {
  return {
    ...workJobs(CLIP_RECAPTION_QUEUE, "clipId"),
    async send(clipId, recaptionId) {
      const jobId = await (await getBoss()).send(CLIP_RECAPTION_QUEUE, { clipId, recaptionId }, { retryLimit: 0, expireInSeconds: 30 * 60 });
      if (jobId === null) throw new Error(`caption job for clip ${clipId} was not queued`);
      return jobId;
    },
  };
}

// Writing a clip's title takes seconds once the script writer has loaded, which takes up to 5 minutes; a job writing
// 50 clips gets an hour. It is not retried: the failure is shown on each clip. One cut off by closing Localirs is marked
// failed when the worker starts (failInterruptedWrites).
export function getClipWriterJobs(): ClipWriterQueue & StartupWorkJobs {
  return {
    ...workJobs(CLIP_WRITER_QUEUE, "writeId"),
    async send(writeId, clipIds) {
      const jobId = await (await getBoss()).send(CLIP_WRITER_QUEUE, { writeId, clipIds }, { retryLimit: 0, expireInSeconds: 60 * 60 });
      if (jobId === null) throw new Error(`writing job ${writeId} was not queued`);
      return jobId;
    },
  };
}

export function getSlideshowJobs(): StartupWorkJobs {
  return workJobs(SLIDESHOW_QUEUE, "slideshowJobId");
}

// A slideshow engine downloads up to 7 GB; it gets a day, like the AI engine. Writing a script takes a minute or two;
// making a slideshow takes up to half an hour on a laptop that draws several pictures (1-3 minutes each). Neither is
// retried: the failure is shown on the Clips page or in Settings.
export function getSlideshowEngineQueue(): SlideshowEngineQueue {
  return {
    async send(engine) {
      const jobId = await (await getBoss()).send(SLIDESHOW_ENGINE_QUEUE, { engine }, { retryLimit: 0, expireInSeconds: 24 * 60 * 60 });
      if (jobId === null) throw new Error(`the ${engine} engine install was not queued`);
      return jobId;
    },
  };
}

export function getSlideshowQueue(): SlideshowQueue {
  return {
    async send(slideshowJobId, kind) {
      const jobId = await (await getBoss()).send(SLIDESHOW_QUEUE, { slideshowJobId, kind }, { retryLimit: 0, expireInSeconds: 2 * 60 * 60 });
      if (jobId === null) throw new Error(`slideshow ${slideshowJobId} was not queued`);
      return jobId;
    },
  };
}

// A backup that copies the clips can take a long time on a slow drive; it gets 6 hours. It is not retried: the failure
// is listed in Settings, and the next day's backup runs anyway.
export async function enqueueBackup(): Promise<string> {
  const jobId = await (await getBoss()).send(BACKUP_QUEUE, {}, { retryLimit: 0, expireInSeconds: 6 * 60 * 60 });
  if (jobId === null) throw new Error("the backup was not queued");
  return jobId;
}

export function getInsightsQueue(): InsightQueue {
  return insightQueue(INSIGHTS_QUEUE);
}

// A YouTube post's view, like and comment counts, pulled on the same 1 h, 24 h and 7 d schedule.
export function getYouTubeStatsQueue(): InsightQueue {
  return insightQueue(YOUTUBE_STATS_QUEUE);
}

function insightQueue(name: string): InsightQueue {
  return {
    async send(postId, label, runAt) {
      return (await getBoss()).sendAfter(
        name,
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
