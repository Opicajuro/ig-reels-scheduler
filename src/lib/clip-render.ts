import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { requireEnv } from "./env";
import { buildClipKey, buildClipSourceKey } from "./storage";
import type { ClipStore } from "./clip-store";
import { captionsForClip } from "@/clip-engine/captions-timing.js";
import { downloadVideo } from "@/clip-engine/download.js";
import { audioSamples, cutForCaptions, motionFrames, probeDuration, renderClip } from "@/clip-engine/ffmpeg.js";
import { loudnessPerSecond, motionPerSecond } from "@/clip-engine/analysis.js";
import { combineScores, MIN_SEGMENT_SECONDS, pickHighlights, resolveClipCount } from "@/clip-engine/helpers.js";
import { bundleCaptions, renderCaptions } from "@/clip-engine/render-captions.js";
import { transcribeToCaptions } from "@/clip-engine/transcribe.js";

export function clipName(index: number): string {
  return `clip-${String(index + 1).padStart(3, "0")}`;
}

// Renders a project's clips from its source video. The project must already be in the "rendering" state.
export async function renderClipProject({
  db,
  store,
  projectId,
  workDir,
}: {
  db: PrismaClient;
  store: ClipStore;
  projectId: string;
  workDir: string;
}) {
  const project = await db.clipProject.findUnique({ where: { id: projectId } });
  if (!project) throw new Error(`clip project ${projectId} not found`);
  if (project.status !== "rendering") throw new Error(`clip project ${projectId} is not rendering`);

  try {
    const previous = await db.clip.findMany({ where: { projectId }, select: { storageKey: true } });
    for (const clip of previous) await store.remove(clip.storageKey);
    await db.clip.deleteMany({ where: { projectId } });

    const sourcePath = path.join(workDir, "source.mp4");
    if (project.sourceKey) {
      await store.downloadTo(project.sourceKey, sourcePath);
    } else {
      if (!project.sourceUrl) throw new Error("project has neither an uploaded source nor a link");
      await downloadVideo(project.sourceUrl, workDir);
      const sourceKey = buildClipSourceKey(projectId, ".mp4");
      await store.upload(sourceKey, sourcePath, "video/mp4");
      await db.clipProject.update({ where: { id: projectId }, data: { sourceKey } });
    }

    const durationSeconds = Math.floor(await probeDuration(sourcePath));
    if (durationSeconds < MIN_SEGMENT_SECONDS) {
      throw new Error(`video is shorter than ${MIN_SEGMENT_SECONDS} seconds`);
    }
    await db.clipProject.update({ where: { id: projectId }, data: { durationSeconds } });

    const clipCount = resolveClipCount(project.clipCount, durationSeconds, project.clipSeconds);
    // Each of these reads the whole video in its own process, so they run at the same time.
    const [motion, audio, captions] = await Promise.all([
      motionPerSecond(motionFrames(sourcePath), durationSeconds),
      loudnessPerSecond(audioSamples(sourcePath), durationSeconds),
      project.withCaptions
        ? transcribeToCaptions({
            mediaPath: sourcePath,
            workDir,
            whisperBin: requireEnv("WHISPER_BIN"),
            model: requireEnv("WHISPER_MODEL"),
          })
        : null,
    ]);
    const highlights = pickHighlights(combineScores(motion, audio), project.clipSeconds, clipCount).map(
      (highlight) => ({ ...highlight, clipId: randomUUID() }),
    );

    // Captions are rendered from one Remotion bundle for the whole project. Bundling copies its public folder,
    // so every cut must be there first.
    const captionBundle = captions ? await cutAndBundle(sourcePath, highlights, path.join(workDir, "public")) : null;

    for (const [index, highlight] of highlights.entries()) {
      const { clipId } = highlight;
      const output = path.join(workDir, `${clipId}.mp4`);
      if (captions && captionBundle) {
        await renderCaptions({
          serveUrl: captionBundle,
          src: `${clipId}.mp4`,
          durationSeconds: highlight.length,
          captions: captionsForClip(captions, highlight.start * 1000, (highlight.start + highlight.length) * 1000),
          output,
          chromePath: requireEnv("CHROME_PATH"),
          preset: project.captionPreset,
          position: project.captionPosition,
          uppercase: project.captionUppercase,
        });
      } else {
        await renderClip({ input: sourcePath, output, start: highlight.start, length: highlight.length });
      }

      const storageKey = buildClipKey(projectId, clipId);
      await store.upload(storageKey, output, "video/mp4");
      await db.clip.create({
        data: {
          id: clipId,
          projectId,
          name: clipName(index),
          start: highlight.start,
          length: highlight.length,
          storageKey,
        },
      });
    }

    await db.clipProject.update({ where: { id: projectId }, data: { status: "done", error: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.clipProject.update({ where: { id: projectId }, data: { status: "failed", error: message } });
    throw err;
  }
}

async function cutAndBundle(
  sourcePath: string,
  highlights: { clipId: string; start: number; length: number }[],
  publicDir: string,
): Promise<string> {
  await mkdir(publicDir, { recursive: true });
  for (const highlight of highlights) {
    await cutForCaptions({
      input: sourcePath,
      output: path.join(publicDir, `${highlight.clipId}.mp4`),
      start: highlight.start,
      length: highlight.length,
    });
  }
  return bundleCaptions(publicDir);
}
