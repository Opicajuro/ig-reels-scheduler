import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildReelKey } from "./storage";
import { transcodeToReel } from "./transcode";

type MediaJobDeps = {
  db: PrismaClient;
  mediaId: string;
  fetchFn: typeof fetch;
  getDownloadUrl: (key: string) => Promise<string>;
  getUploadUrl: (key: string, contentType: string) => Promise<string>;
};

export async function processMedia({ db, mediaId, fetchFn, getDownloadUrl, getUploadUrl }: MediaJobDeps) {
  const media = await db.media.findUnique({ where: { id: mediaId } });
  if (!media) throw new Error(`media ${mediaId} not found`);
  if (media.status === "ready") return;

  await db.media.update({ where: { id: mediaId }, data: { status: "transcoding" } });

  try {
    const workDir = await mkdtemp(path.join(os.tmpdir(), "media-"));
    const rawPath = path.join(workDir, `raw${path.extname(media.rawKey)}`);
    const reelPath = path.join(workDir, "reel.mp4");

    const download = await fetchFn(await getDownloadUrl(media.rawKey));
    if (!download.ok) throw new Error(`download of ${media.rawKey} failed with ${download.status}`);
    await writeFile(rawPath, Buffer.from(await download.arrayBuffer()));

    const { durationSeconds, width, height } = await transcodeToReel({ inputPath: rawPath, outputPath: reelPath });

    const reelKey = buildReelKey(mediaId);
    const upload = await fetchFn(await getUploadUrl(reelKey, "video/mp4"), {
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
      body: new Blob([await readFile(reelPath)], { type: "video/mp4" }),
    });
    if (!upload.ok) throw new Error(`upload of ${reelKey} failed with ${upload.status}`);

    await db.media.update({
      where: { id: mediaId },
      data: { status: "ready", reelKey, durationMs: Math.round(durationSeconds * 1000), width, height, error: null },
    });
  } catch (err) {
    await db.media.update({
      where: { id: mediaId },
      data: { status: "failed", error: err instanceof Error ? err.message : String(err) },
    });
  }
}
