import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildReelKey } from "./storage";
import { transcodeToReel } from "./transcode";

// The file moves stream between storage and disk (src/lib/storage.ts), so a large upload never sits in memory.
type MediaJobDeps = {
  db: PrismaClient;
  mediaId: string;
  downloadToFile: (key: string, filePath: string) => Promise<void>;
  uploadFromFile: (key: string, filePath: string, contentType: string) => Promise<void>;
};

export async function processMedia({ db, mediaId, downloadToFile, uploadFromFile }: MediaJobDeps) {
  const media = await db.media.findUnique({ where: { id: mediaId } });
  if (!media) throw new Error(`media ${mediaId} not found`);
  if (media.status === "ready") return;

  await db.media.update({ where: { id: mediaId }, data: { status: "transcoding" } });

  const workDir = await mkdtemp(path.join(os.tmpdir(), "media-"));
  try {
    const rawPath = path.join(workDir, `raw${path.extname(media.rawKey)}`);
    const reelPath = path.join(workDir, "reel.mp4");

    await downloadToFile(media.rawKey, rawPath);
    const { durationSeconds, width, height } = await transcodeToReel({ inputPath: rawPath, outputPath: reelPath });

    const reelKey = buildReelKey(mediaId);
    await uploadFromFile(reelKey, reelPath, "video/mp4");

    await db.media.update({
      where: { id: mediaId },
      data: { status: "ready", reelKey, durationMs: Math.round(durationSeconds * 1000), width, height, error: null },
    });
  } catch (err) {
    await db.media.update({
      where: { id: mediaId },
      data: { status: "failed", error: err instanceof Error ? err.message : String(err) },
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
