import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Job } from "pg-boss";
import { refreshDueTokens } from "@/lib/refresh-job";
import { renderClipProject } from "@/lib/clip-render";
import { s3ClipStore } from "@/lib/clip-store";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";
import {
  CLIP_QUEUE,
  getBoss,
  INSIGHTS_QUEUE,
  MEDIA_QUEUE,
  OWNER_ALERTS_QUEUE,
  PUBLISH_QUEUE,
  TOKEN_REFRESH_QUEUE,
} from "@/lib/queues";
import { processInsightsJob } from "./insights-processor";
import { processMedia } from "@/lib/media-jobs";
import { presignDownload, presignUpload } from "@/lib/storage";
import { createPublishProcessor } from "./publish-processor";
import { sendOwnerAlerts } from "@/lib/alert-job";
import { sendEmail } from "@/lib/alerts";

const DAILY_AT_03_UTC = "0 3 * * *";
const DAILY_AT_08_UTC = "0 8 * * *";
const DOWNLOAD_LIFETIME_SECONDS = 7200;

async function main() {
  const boss = await getBoss();

  await boss.schedule(TOKEN_REFRESH_QUEUE, DAILY_AT_03_UTC, {}, { tz: "UTC" });
  await boss.work(TOKEN_REFRESH_QUEUE, async () => {
    await refreshDueTokens(prisma, { now: new Date(), key: loadTokenKey() });
  });

  await boss.work(MEDIA_QUEUE, async ([job]: Job<{ mediaId: string }>[]) => {
    await processMedia({
      db: prisma,
      mediaId: job.data.mediaId,
      fetchFn: fetch,
      getDownloadUrl: (key) => presignDownload(key, DOWNLOAD_LIFETIME_SECONDS),
      getUploadUrl: (key, contentType) => presignUpload(key, contentType),
    });
  });

  await boss.work(CLIP_QUEUE, async ([job]: Job<{ projectId: string }>[]) => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "clip-project-"));
    try {
      await renderClipProject({ db: prisma, store: s3ClipStore, projectId: job.data.projectId, workDir });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  await boss.work(PUBLISH_QUEUE, createPublishProcessor());
  await boss.work(INSIGHTS_QUEUE, processInsightsJob);

  await boss.schedule(OWNER_ALERTS_QUEUE, DAILY_AT_08_UTC, {}, { tz: "UTC" });
  await boss.work(OWNER_ALERTS_QUEUE, async () => {
    await sendOwnerAlerts({ db: prisma, now: new Date(), send: sendEmail });
  });

  console.log(`worker running: token refresh at ${DAILY_AT_03_UTC} UTC, media, clips and publishing enabled`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
