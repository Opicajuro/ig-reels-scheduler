import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClipProject, PrismaClient } from "@/generated/prisma/client";
import { requireEnv } from "./env";
import { buildClipKey, buildClipSourceKey } from "./storage";
import type { ClipStore } from "./clip-store";
import { captionLines, captionsForClip, captionStills } from "@/clip-engine/captions-timing.js";
import { downloadVideo } from "@/clip-engine/download.js";
import {
  audioSamples,
  motionFrames,
  overlayList,
  probeDuration,
  renderBlankOverlay,
  renderClip,
} from "@/clip-engine/ffmpeg.js";
import { loudnessPerSecond, motionPerSecond } from "@/clip-engine/analysis.js";
import { combineScores, MIN_SEGMENT_SECONDS, pickHighlights, resolveClipCount } from "@/clip-engine/helpers.js";
import { bundleCaptions, renderCaptionStills } from "@/clip-engine/render-captions.js";
import { captionPreset } from "@/clip-engine/remotion/caption-presets.js";
import { transcribeToWords } from "@/clip-engine/transcribe.js";

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

  // Tells the project page what is happening now, one write per step.
  const step = (renderStep: string) => db.clipProject.update({ where: { id: projectId }, data: { renderStep } });

  try {
    const previous = await db.clip.findMany({ where: { projectId }, select: { storageKey: true } });
    for (const clip of previous) await store.remove(clip.storageKey);
    await db.clip.deleteMany({ where: { projectId } });

    await step("Downloading the video");
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
    await step(project.withCaptions ? "Analysing motion and sound and transcribing" : "Analysing motion and sound");
    // Each of these reads the whole video in its own process, so they run at the same time.
    const [motion, audio, words] = await Promise.all([
      motionPerSecond(motionFrames(sourcePath), durationSeconds),
      loudnessPerSecond(audioSamples(sourcePath), durationSeconds),
      project.withCaptions
        ? transcribeToWords({
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

    // Each caption is drawn once as a PNG, all from one Remotion bundle, then laid over its clip by ffmpeg.
    if (words) await step("Drawing captions");
    const overlays = words
      ? await captionOverlays(captionLines(words), highlights, path.join(workDir, "captions"), project)
      : null;

    for (const [index, highlight] of highlights.entries()) {
      await step(`Making clip ${index + 1} of ${highlights.length}`);
      const { clipId } = highlight;
      const output = path.join(workDir, `${clipId}.mp4`);
      await renderClip({
        input: sourcePath,
        output,
        start: highlight.start,
        length: highlight.length,
        overlay: overlays?.get(clipId) ?? null,
      });

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

    await db.clipProject.update({ where: { id: projectId }, data: { status: "done", error: null, renderStep: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.clipProject.update({ where: { id: projectId }, data: { status: "failed", error: message, renderStep: null } });
    throw err;
  }
}

// Draws every caption of the project and returns, per clip, the ffconcat list that times its captions.
async function captionOverlays(
  lines: ReturnType<typeof captionLines>,
  highlights: { clipId: string; start: number; length: number }[],
  dir: string,
  look: Pick<ClipProject, "captionPreset" | "captionPosition" | "captionUppercase">,
): Promise<Map<string, string>> {
  await mkdir(dir, { recursive: true });
  const { wordByWord } = captionPreset(look.captionPreset);
  const clips = highlights.map((highlight) => {
    const clipLines = captionsForClip(lines, highlight.start * 1000, (highlight.start + highlight.length) * 1000);
    const stills: { words: string[]; highlight: number | null; startMs: number; endMs: number }[] = captionStills(
      clipLines,
      wordByWord,
    );
    const overlays = stills.map((still, index) => ({
      words: still.words,
      highlight: still.highlight,
      image: path.join(dir, `${highlight.clipId}-${index}.png`),
      start: still.startMs / 1000,
      end: still.endMs / 1000,
    }));
    return { ...highlight, overlays };
  });
  await renderCaptionStills({
    serveUrl: await bundleCaptions(),
    stills: clips.flatMap((clip) =>
      clip.overlays.map(({ words, highlight, image }) => ({ words, highlight, output: image })),
    ),
    chromePath: requireEnv("CHROME_PATH"),
    preset: look.captionPreset,
    position: look.captionPosition,
    uppercase: look.captionUppercase,
  });
  const blank = path.join(dir, "blank.png");
  await renderBlankOverlay(blank);

  const lists = new Map<string, string>();
  for (const clip of clips) {
    const list = path.join(dir, `${clip.clipId}.ffconcat`);
    await writeFile(list, overlayList({ overlays: clip.overlays, blank, length: clip.length }));
    lists.set(clip.clipId, list);
  }
  return lists;
}
