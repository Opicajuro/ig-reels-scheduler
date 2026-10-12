import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { requireEnv } from "./env";
import { buildClipKey, buildClipSourceKey } from "./storage";
import type { ClipStore } from "./clip-store";
import { captionsForClip } from "@/clip-engine/captions-timing.js";
import { downloadVideo } from "@/clip-engine/download.js";
import { audioSamples, motionFrames, probeDuration, renderClip } from "@/clip-engine/ffmpeg.js";
import { loudnessPerSecond, motionPerSecond } from "@/clip-engine/analysis.js";
import { combineScores, MIN_SEGMENT_SECONDS, pickHighlights, resolveClipCount } from "@/clip-engine/helpers.js";
import { renderCaptionedClip } from "@/clip-engine/render-captions.js";
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
    const motion = await motionPerSecond(motionFrames(sourcePath), durationSeconds);
    const audio = await loudnessPerSecond(audioSamples(sourcePath), durationSeconds);
    const highlights = pickHighlights(combineScores(motion, audio), project.clipSeconds, clipCount);

    const captions = project.withCaptions
      ? await transcribeToCaptions({
          mediaPath: sourcePath,
          workDir,
          whisperBin: requireEnv("WHISPER_BIN"),
          model: requireEnv("WHISPER_MODEL"),
        })
      : null;

    for (const [index, highlight] of highlights.entries()) {
      const clipId = randomUUID();
      const output = path.join(workDir, `${clipId}.mp4`);
      if (captions) {
        const cutPath = path.join(workDir, `${clipId}.cut.mp4`);
        await renderClip({ input: sourcePath, output: cutPath, start: highlight.start, length: highlight.length });
        await renderCaptionedClip({
          clipPath: cutPath,
          durationSeconds: highlight.length,
          captions: captionsForClip(captions, highlight.start * 1000, (highlight.start + highlight.length) * 1000),
          output,
          chromePath: requireEnv("CHROME_PATH"),
          preset: project.captionPreset,
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
