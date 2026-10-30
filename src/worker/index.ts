import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Job } from "pg-boss";
import { refreshDueTokens } from "@/lib/refresh-job";
import { renderClipProject } from "@/lib/clip-render";
import { requeueInterruptedRenders } from "@/lib/clip-resume";
import { s3ClipStore } from "@/lib/clip-store";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";
import { aiDir, comfyRoot } from "@/lib/ai-engine";
import { installAiEngine } from "@/lib/ai-install";
import { runAiVideoJob } from "@/lib/ai-video";
import { startComfy } from "@/lib/comfy";
import {
  AI_ENGINE_QUEUE,
  AI_VIDEO_QUEUE,
  BACKUP_QUEUE,
  CLIP_QUEUE,
  getBoss,
  getClipJobs,
  INSIGHTS_QUEUE,
  MEDIA_QUEUE,
  OWNER_ALERTS_QUEUE,
  PUBLISH_QUEUE,
  TOKEN_REFRESH_QUEUE,
} from "@/lib/queues";
import { processInsightsJob } from "./insights-processor";
import { processMedia } from "@/lib/media-jobs";
import { downloadToFile, uploadFromFile } from "@/lib/storage";
import { createPublishProcessor } from "./publish-processor";
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

  await boss.work(AI_ENGINE_QUEUE, async () => {
    await installAiEngine({ db: prisma, dir: aiDir() });
  });

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

  await boss.work(PUBLISH_QUEUE, createPublishProcessor());
  await boss.work(INSIGHTS_QUEUE, processInsightsJob);

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

  console.log(`worker running: token refresh at ${DAILY_AT_03_UTC} UTC, media, clips, AI videos and publishing enabled, backups at 03:30 ${timeZone}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
