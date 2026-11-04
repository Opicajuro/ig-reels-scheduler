import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Job } from "pg-boss";
import { refreshDueTokens } from "@/lib/refresh-job";
import { recaptionClip, renderClipProject } from "@/lib/clip-render";
import { requeueInterruptedRecaptions, requeueInterruptedRenders } from "@/lib/clip-resume";
import { failInterruptedWrites, runClipWriter } from "@/lib/clip-writer";
import { startLlamaServer } from "@/lib/llm-script";
import { failInterruptedAiVideos, failInterruptedSlideshows } from "@/lib/work-cleanup";
import { s3ClipStore } from "@/lib/clip-store";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";
import { aiDir, comfyRoot } from "@/lib/ai-engine";
import { installAiEngine } from "@/lib/ai-install";
import { runAiVideoJob } from "@/lib/ai-video";
import { startComfy } from "@/lib/comfy";
import { installSlideshowEngine, isSlideshowEngineId, scriptWriterPaths, slideshowDir } from "@/lib/slideshow-engines";
import { localSlideshowTools, runSlideshowJob } from "@/lib/slideshow-render";
import {
  AI_ENGINE_QUEUE,
  AI_VIDEO_QUEUE,
  BACKUP_QUEUE,
  CLIP_QUEUE,
  CLIP_RECAPTION_QUEUE,
  CLIP_WRITER_QUEUE,
  getAiVideoJobs,
  getBoss,
  getClipJobs,
  getClipWriterJobs,
  getRecaptionJobs,
  getSlideshowJobs,
  INSIGHTS_QUEUE,
  MEDIA_QUEUE,
  OWNER_ALERTS_QUEUE,
  PUBLISH_QUEUE,
  SLIDESHOW_ENGINE_QUEUE,
  SLIDESHOW_QUEUE,
  TOKEN_REFRESH_QUEUE,
  YOUTUBE_PUBLISH_QUEUE,
  YOUTUBE_STATS_QUEUE,
} from "@/lib/queues";
import { processInsightsJob } from "./insights-processor";
import { processMedia } from "@/lib/media-jobs";
import { downloadToFile, uploadFromFile } from "@/lib/storage";
import { createPublishProcessor } from "./publish-processor";
import { createYouTubePublishProcessor, processYouTubeStatsJob } from "./youtube-processor";
import { sendOwnerAlerts } from "@/lib/alert-job";
import { sendEmail } from "@/lib/alerts";
import { getOwnerId } from "@/lib/owner";
import { emailSettings, getSettings } from "@/lib/settings";
import { videoEncoder } from "@/clip-engine/encoder.js";
import { recordVideoEncoder, VIDEO_ENCODER_LABELS } from "@/lib/video-encoding";
import { runBackup, settleUnfinishedBackups } from "@/lib/backup";
import { requireEnv } from "@/lib/env";

const DAILY_AT_03_UTC = "0 3 * * *";
const DAILY_AT_08_UTC = "0 8 * * *";
const DAILY_AT_0330 = "30 3 * * *";

async function main() {
  const encoder = await videoEncoder();
  await recordVideoEncoder(prisma, encoder);
  console.log(`video encoder: ${VIDEO_ENCODER_LABELS[encoder]}`);

  const boss = await getBoss();

  await boss.schedule(TOKEN_REFRESH_QUEUE, DAILY_AT_03_UTC, {}, { tz: "UTC" });
  await boss.work(TOKEN_REFRESH_QUEUE, async () => {
    await refreshDueTokens(prisma, { now: new Date(), key: loadTokenKey() });
  });

  await boss.work(MEDIA_QUEUE, async ([job]: Job<{ mediaId: string }>[]) => {
    await processMedia({ db: prisma, mediaId: job.data.mediaId, downloadToFile, uploadFromFile });
  });

  // Before clip jobs are taken, so a job the closed worker had claimed is not mistaken for one running now.
  const resumed = await requeueInterruptedRenders({ db: prisma, jobs: getClipJobs() });
  if (resumed.length > 0) console.log(`resuming clips for ${resumed.length} project(s)`);
  await boss.work(CLIP_QUEUE, async ([job]: Job<{ projectId: string; renderId: string }>[]) => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "clip-project-"));
    try {
      const { projectId, renderId } = job.data;
      await renderClipProject({ db: prisma, store: s3ClipStore, projectId, renderId, workDir });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  const recaptioned = await requeueInterruptedRecaptions({ db: prisma, jobs: getRecaptionJobs() });
  if (recaptioned.length > 0) console.log(`re-rendering captions of ${recaptioned.length} clip(s) again`);
  await boss.work(CLIP_RECAPTION_QUEUE, async ([job]: Job<{ clipId: string; recaptionId: string }>[]) => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "clip-recaption-"));
    try {
      const { clipId, recaptionId } = job.data;
      await recaptionClip({ db: prisma, store: s3ClipStore, clipId, recaptionId, workDir });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  await boss.work(AI_ENGINE_QUEUE, async () => {
    await installAiEngine({ db: prisma, dir: aiDir() });
  });

  const stopped = await failInterruptedAiVideos({ db: prisma, jobs: getAiVideoJobs() });
  if (stopped.length > 0) console.log(`marked ${stopped.length} AI video(s) cut off by closing Localirs as failed`);
  // One video at a time (pg-boss hands out one job per worker by default): the graphics card holds one model.
  await boss.work(AI_VIDEO_QUEUE, async ([job]: Job<{ aiVideoJobId: string }>[]) => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "ai-video-"));
    try {
      await runAiVideoJob({
        db: prisma,
        store: s3ClipStore,
        jobId: job.data.aiVideoJobId,
        workDir,
        startComfy: () => startComfy(comfyRoot(aiDir())),
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  await boss.work(SLIDESHOW_ENGINE_QUEUE, async ([job]: Job<{ engine: string }>[]) => {
    const { engine } = job.data;
    if (!isSlideshowEngineId(engine)) throw new Error(`unknown slideshow engine "${engine}"`);
    await installSlideshowEngine({ db: prisma, root: slideshowDir(), engine });
  });

  const stoppedShows = await failInterruptedSlideshows({ db: prisma, jobs: getSlideshowJobs() });
  if (stoppedShows.length > 0) console.log(`marked ${stoppedShows.length} slideshow(s) cut off by closing Localirs as failed`);
  // One slideshow at a time: the script writer and the picture maker each fill the graphics card.
  await boss.work(SLIDESHOW_QUEUE, async ([job]: Job<{ slideshowJobId: string; kind: "script" | "render" }>[]) => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "slideshow-"));
    try {
      const { slideshowJobId, kind } = job.data;
      await runSlideshowJob({ db: prisma, store: s3ClipStore, jobId: slideshowJobId, kind, workDir, tools: localSlideshowTools(prisma) });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  const unwritten = await failInterruptedWrites({ db: prisma, jobs: getClipWriterJobs() });
  if (unwritten.length > 0) console.log(`marked ${unwritten.length} title writing job(s) cut off by closing Localirs as failed`);
  // One at a time, like the slideshows: the script writer fills the graphics card.
  await boss.work(CLIP_WRITER_QUEUE, async ([job]: Job<{ writeId: string; clipIds: string[] }>[]) => {
    const root = slideshowDir();
    const script = scriptWriterPaths(root);
    await runClipWriter({
      db: prisma,
      writeId: job.data.writeId,
      clipIds: job.data.clipIds,
      // Its own log, as a slideshow's script may be written at the same time.
      startLlm: (signal) =>
        startLlamaServer({ server: script.server, model: script.model, logPath: path.join(root, "llama-server-titles.log"), signal }),
    });
  });

  await boss.work(PUBLISH_QUEUE, createPublishProcessor());
  await boss.work(INSIGHTS_QUEUE, processInsightsJob);
  await boss.work(YOUTUBE_PUBLISH_QUEUE, createYouTubePublishProcessor());
  await boss.work(YOUTUBE_STATS_QUEUE, processYouTubeStatsJob);

  // Failure emails are optional. The settings are read at each run, so saving them on /settings turns the emails on
  // or off without restarting the worker.
  await boss.schedule(OWNER_ALERTS_QUEUE, DAILY_AT_08_UTC, {}, { tz: "UTC" });
  await boss.work(OWNER_ALERTS_QUEUE, async () => {
    const email = emailSettings(await getSettings(prisma));
    if (!email) return;
    await sendOwnerAlerts({
      db: prisma,
      ownerId: await getOwnerId(),
      now: new Date(),
      send: (message) => sendEmail({ ...email, ...message }),
    });
  });

  // At 03:30 in this PC's time zone. A PC that was off then makes the missed backup as soon as the worker starts.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await settleUnfinishedBackups(prisma, new Date());
  await boss.schedule(BACKUP_QUEUE, DAILY_AT_0330, {}, { tz: timeZone, missed: "once" });
  await boss.work(BACKUP_QUEUE, async () => {
    const env = {
      dataDir: requireEnv("LOCALIRS_DATA_DIR"),
      pgBin: requireEnv("PG_BIN"),
      databaseUrl: requireEnv("DATABASE_URL"),
      // The worker runs in the app folder, next to the app's .env.
      appEnvFile: path.join(process.cwd(), ".env"),
    };
    await runBackup({ db: prisma, env, now: new Date() });
  });

  console.log(`worker running: token refresh at ${DAILY_AT_03_UTC} UTC, media, clips, AI videos, slideshows, AI titles, Instagram and YouTube publishing enabled, backups at 03:30 ${timeZone}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
