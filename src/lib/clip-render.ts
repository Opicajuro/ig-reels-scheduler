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
import { remainingClips, requireRenderId, resumablePlan, resumeStep, type RenderPlan } from "./clip-resume";

export function clipName(index: number): string {
  return `clip-${String(index + 1).padStart(3, "0")}`;
}

// Renders a project's clips from its source video. The project must already be in the "rendering" state, for the
// render the job was queued for. A render whose plan is already stored was interrupted: it keeps the clips it saved
// and makes the rest; otherwise it replaces the project's clips.
export async function renderClipProject({
  db,
  store,
  projectId,
  renderId,
  workDir,
}: {
  db: PrismaClient;
  store: ClipStore;
  projectId: string;
  renderId: string;
  workDir: string;
}) {
  const project = await db.clipProject.findUnique({ where: { id: projectId } });
  if (!project) throw new Error(`clip project ${projectId} not found`);
  if (project.status !== "rendering") throw new Error(`clip project ${projectId} is not rendering`);
  if (requireRenderId(project) !== renderId) throw new Error(`clip job for project ${projectId} is for an earlier render`);

  // Tells the project page what is happening now, one write per step.
  const step = (renderStep: string) => db.clipProject.update({ where: { id: projectId }, data: { renderStep } });

  try {
    const saved = await db.clip.findMany({ where: { projectId }, select: { id: true, storageKey: true } });
    const stored = resumablePlan(renderId, project.renderPlan);
    const resume = stored ? { plan: stored, remaining: remainingClips(stored, saved.map((clip) => clip.id)) } : null;
    if (!resume) {
      for (const clip of saved) await store.remove(clip.storageKey);
      await db.clip.deleteMany({ where: { projectId } });
    } else if (resume.remaining.length === 0) {
      await db.clipProject.update({ where: { id: projectId }, data: { status: "done", error: null, renderStep: null } });
      return;
    }
    // While resuming, the page shows the clip it goes on from until that clip is being made.
    const resumeLabel = resume ? resumeStep(resume.remaining[0].index + 1, resume.plan.clips.length) : null;

    await step(resumeLabel ?? "Downloading the video");
    const sourcePath = path.join(workDir, "source.mp4");
    if (project.sourceKey) {
      await store.downloadTo(project.sourceKey, sourcePath);
    } else {
      if (resume) throw new Error("an interrupted render has no stored source video");
      if (!project.sourceUrl) throw new Error("project has neither an uploaded source nor a link");
      await downloadVideo(project.sourceUrl, workDir);
      const sourceKey = buildClipSourceKey(projectId, ".mp4");
      await store.upload(sourceKey, sourcePath, "video/mp4");
      await db.clipProject.update({ where: { id: projectId }, data: { sourceKey } });
    }

    let plan: RenderPlan;
    let words: Awaited<ReturnType<typeof transcribe>> | null;
    if (resume) {
      // The highlights are not picked again, but captions need the words.
      plan = resume.plan;
      words = project.withCaptions ? await transcribe(sourcePath, workDir) : null;
    } else {
      const durationSeconds = Math.floor(await probeDuration(sourcePath));
      if (durationSeconds < MIN_SEGMENT_SECONDS) {
        throw new Error(`video is shorter than ${MIN_SEGMENT_SECONDS} seconds`);
      }
      await db.clipProject.update({ where: { id: projectId }, data: { durationSeconds } });

      const clipCount = resolveClipCount(project.clipCount, durationSeconds, project.clipSeconds);
      await step(project.withCaptions ? "Analysing motion and sound and transcribing" : "Analysing motion and sound");
      // Each of these reads the whole video in its own process, so they run at the same time.
      const [motion, audio, transcript] = await Promise.all([
        motionPerSecond(motionFrames(sourcePath), durationSeconds),
        loudnessPerSecond(audioSamples(sourcePath), durationSeconds),
        project.withCaptions ? transcribe(sourcePath, workDir) : null,
      ]);
      words = transcript;
      const clips = pickHighlights(combineScores(motion, audio), project.clipSeconds, clipCount).map((highlight) => ({
        clipId: randomUUID(),
        start: highlight.start,
        length: highlight.length,
      }));
      // Stored before the first clip, so a render cut off from here on makes the same clips when it goes on.
      plan = { renderId, clips };
      await db.clipProject.update({ where: { id: projectId }, data: { renderPlan: plan } });
    }
    const todo = resume ? resume.remaining : plan.clips.map((clip, index) => ({ index, clip }));
    const total = plan.clips.length;

    // Each caption is drawn once as a PNG, all from one Remotion bundle, then laid over its clip by ffmpeg.
    if (words && !resumeLabel) await step("Drawing captions");
    const overlays = words
      ? await captionOverlays(
          captionLines(words),
          todo.map(({ clip }) => clip),
          path.join(workDir, "captions"),
          project,
        )
      : null;

    for (const { index, clip } of todo) {
      await step(resume ? resumeStep(index + 1, total) : `Making clip ${index + 1} of ${total}`);
      const { clipId } = clip;
      const output = path.join(workDir, `${clipId}.mp4`);
      await renderClip({
        input: sourcePath,
        output,
        start: clip.start,
        length: clip.length,
        overlay: overlays?.get(clipId) ?? null,
      });

      // The key comes from the planned clip id, so a clip uploaded just before an interruption is overwritten.
      const storageKey = buildClipKey(projectId, clipId);
      await store.upload(storageKey, output, "video/mp4");
      await db.clip.create({
        data: {
          id: clipId,
          projectId,
          name: clipName(index),
          start: clip.start,
          length: clip.length,
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

function transcribe(mediaPath: string, workDir: string) {
  return transcribeToWords({
    mediaPath,
    workDir,
    whisperBin: requireEnv("WHISPER_BIN"),
    model: requireEnv("WHISPER_MODEL"),
  });
}

// Draws every caption of the project and returns, per clip, the ffconcat list that times its captions. Slideshows use
// it too.
export async function captionOverlays(
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
