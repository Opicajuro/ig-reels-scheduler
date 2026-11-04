import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma, type ClipProject, type PrismaClient } from "@/generated/prisma/client";
import { requireEnv } from "./env";
import { buildClipBaseKey, buildClipKey, buildClipSourceKey, buildClipVersionKey } from "./storage";
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
import { lineEmoji } from "@/clip-engine/caption-emoji.js";
import { renderCaptionStills, renderTitleStills, withCaptionBundle } from "@/clip-engine/render-captions.js";
import { captionPreset, videoColor } from "@/clip-engine/remotion/caption-presets.js";
import {
  remainingClips,
  requireRenderId,
  resumablePlan,
  resumeStep,
  type PlannedClip,
  type RenderPlan,
} from "./clip-resume";
import { transcribeWithWhisper } from "./whisper";
import { mixBackgroundMusic } from "@/clip-engine/music.js";
import { musicFile } from "./music-files";
import { parseTranscript, validateHighlights, type Highlight, type Word } from "./highlights";
import { clipLines, clipWords, parseClipWords } from "./caption-words";
import { tightenClip } from "@/clip-engine/pacing.js";
import { SOURCE_DELETED } from "./storage-messages";
import { parseCropMode, type Crop } from "@/clip-engine/crop.js";
import { followCrop } from "@/clip-engine/follow.js";
import { loadDetectors } from "@/clip-engine/subject.js";

// Thrown by a render's write once the render is cancelled, to stop it.
class RenderCancelled extends Error {}

type Finish = Pick<ClipProject, "progressBar" | "musicTrack" | "musicVolume">;

// The music file is looked up before the first clip is made.
function finishOptions(project: Finish) {
  return {
    progressColor: project.progressBar ? videoColor(project.progressBar) : null,
    music: project.musicTrack ? musicFile(project.musicTrack) : null,
    musicVolume: project.musicVolume,
  };
}

// The finishing step of every clip: lays the captions, hook, end card and progress bar over the cut from input, then
// mixes in the music. A render cuts from the source; drawing a clip's captions again starts from its kept cut. Returns
// the finished file.
async function finishClip({
  input,
  output,
  start,
  length,
  overlay,
  hook,
  endCard,
  tightened,
  crop,
  options,
}: {
  input: string;
  output: string;
  start: number;
  length: number;
  overlay: string | null;
  hook: string | null;
  endCard: string | null;
  // A tightened clip's kept pieces (tightenClip); a clip's kept cut is already tightened.
  tightened: ReturnType<typeof tightenClip> | null;
  // How the picture is cropped from the source; a kept cut is already cropped, and keeps the centre.
  crop: Crop;
  options: ReturnType<typeof finishOptions>;
}): Promise<string> {
  await renderClip({ input, output, start, length, overlay, hook, endCard, progressColor: options.progressColor, tightened, crop });
  if (!options.music) return output;
  const finished = output.replace(/\.mp4$/, "-music.mp4");
  await mixBackgroundMusic({ input: output, music: options.music, volume: options.musicVolume, output: finished });
  return finished;
}

export function clipName(index: number): string {
  return `clip-${String(index + 1).padStart(3, "0")}`;
}

// Runs a project's clip job. "Find highlights" ("picking") downloads and analyses the source and leaves the picked
// highlights for review. "Make clips" ("rendering") renders the project's clips: exactly its reviewed highlights when
// it has them, otherwise the ones it picks. The project must be in the state the job was queued for, for that render.
// A render whose plan is already stored was interrupted: it keeps the clips it saved and makes the rest; otherwise it
// replaces the project's clips.
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
  if (project.status !== "rendering" && project.status !== "picking") {
    throw new Error(`clip project ${projectId} is not rendering or finding highlights`);
  }
  if (requireRenderId(project) !== renderId) throw new Error(`clip job for project ${projectId} is for an earlier render`);

  // Cancelling a render clears the project's render id: from then on its writes do not land, and it stops at the next
  // one, before its next clip at the latest. The clips it made stay.
  const write = async (data: Prisma.ClipProjectUpdateManyMutationInput) => {
    const { count } = await db.clipProject.updateMany({ where: { id: projectId, renderId }, data });
    if (count === 0) throw new RenderCancelled();
  };
  // Tells the project page what is happening now, one write per step.
  const step = (renderStep: string) => write({ renderStep });
  const sourcePath = path.join(workDir, "source.mp4");
  // The source video in the work folder. A linked video is downloaded once and stored with the project.
  const fetchSource = async () => {
    if (project.sourceKey) return store.downloadTo(project.sourceKey, sourcePath);
    if (project.sourceDeletedAt) throw new Error(SOURCE_DELETED);
    if (!project.sourceUrl) throw new Error("project has neither an uploaded source nor a link");
    await downloadVideo(project.sourceUrl, workDir);
    const sourceKey = buildClipSourceKey(projectId, ".mp4");
    await store.upload(sourceKey, sourcePath, "video/mp4");
    await write({ sourceKey });
  };
  // The source's words for captions, transcribed once and then kept on the project.
  const transcript = async (): Promise<Word[]> => {
    if (project.transcript !== null) return parseTranscript(project.transcript);
    const words: Word[] = await transcribeWithWhisper(db, sourcePath, workDir);
    await write({ transcript: words });
    return words;
  };
  // Captions and tightening both work from the words; with them, highlights also start and end on full sentences.
  const needsWords = project.withCaptions || project.tightenPacing;
  // Measures the video and picks its highlights by motion and loudness, transcribing it at the same time when the
  // words are needed.
  const pick = async () => {
    const durationSeconds = Math.floor(await probeDuration(sourcePath));
    if (durationSeconds < MIN_SEGMENT_SECONDS) {
      throw new Error(`video is shorter than ${MIN_SEGMENT_SECONDS} seconds`);
    }
    await write({ durationSeconds });
    const clipCount = resolveClipCount(project.clipCount, durationSeconds, project.clipSeconds);
    const transcribing = needsWords && project.transcript === null;
    await step(transcribing ? "Analysing motion and sound and transcribing" : "Analysing motion and sound");
    // Each of these reads the whole video in its own process, so they run at the same time.
    const [motion, audio, words] = await Promise.all([
      motionPerSecond(motionFrames(sourcePath), durationSeconds),
      loudnessPerSecond(audioSamples(sourcePath), durationSeconds),
      needsWords ? transcript() : null,
    ]);
    const highlights: Highlight[] = pickHighlights(combineScores(motion, audio), project.clipSeconds, clipCount, words).map(
      ({ start, length }: Highlight) => ({ start, length }),
    );
    return { highlights, words };
  };

  try {
    if (project.status === "picking") {
      await step("Downloading the video");
      await fetchSource();
      const { highlights } = await pick();
      await write({ status: "review", renderStep: null, highlights });
      return;
    }

    const saved = await db.clip.findMany({
      where: { projectId },
      select: { id: true, storageKey: true, baseKey: true, start: true, title: true },
    });
    const stored = resumablePlan(renderId, project.renderPlan);
    const resume = stored ? { plan: stored, remaining: remainingClips(stored, saved.map((clip) => clip.id)) } : null;
    // A hook that shows the clip's title keeps the titles of the clips being replaced, for the new clip that starts at
    // the same second: the same video and settings pick the same highlights.
    const keptTitles = new Map<number, string>();
    if (!resume && project.hookMode === "clipTitle") {
      for (const clip of saved) if (clip.title && !keptTitles.has(clip.start)) keptTitles.set(clip.start, clip.title);
    }
    if (!resume) {
      for (const clip of saved) {
        await store.remove(clip.storageKey);
        if (clip.baseKey) await store.remove(clip.baseKey);
      }
      await db.clip.deleteMany({ where: { projectId } });
    } else if (resume.remaining.length === 0) {
      await write({ status: "done", error: null, renderStep: null });
      return;
    }
    // While resuming, the page shows the clip it goes on from until that clip is being made.
    const resumeLabel = resume ? resumeStep(resume.remaining[0].index + 1, resume.plan.clips.length) : null;

    await step(resumeLabel ?? "Downloading the video");
    if (resume && !project.sourceKey) throw new Error("an interrupted render has no stored source video");
    await fetchSource();

    let plan: RenderPlan;
    let words: Word[] | null;
    if (resume) {
      // The highlights are not picked again, but captions and tightening need the words.
      plan = resume.plan;
      words = needsWords ? await transcript() : null;
    } else {
      let highlights: Highlight[];
      if (project.highlights !== null) {
        // Reviewed on the timeline: the video is not analysed again.
        if (project.durationSeconds === null) throw new Error("reviewed highlights without the video's length");
        highlights = validateHighlights(project.highlights, project.durationSeconds);
        if (needsWords && project.transcript === null) await step("Transcribing");
        words = needsWords ? await transcript() : null;
      } else {
        ({ highlights, words } = await pick());
      }
      const clips: PlannedClip[] = highlights.map((highlight) => {
        const title = keptTitles.get(highlight.start);
        return { clipId: randomUUID(), start: highlight.start, length: highlight.length, ...(title ? { title } : {}) };
      });
      // Stored before the first clip, so a render cut off from here on makes the same clips when it goes on.
      plan = { renderId, clips };
      await write({ renderPlan: plan });
    }
    const todo = resume ? resume.remaining : plan.clips.map((clip, index) => ({ index, clip }));
    const total = plan.clips.length;

    // Each caption, hook title and end card is drawn once as a PNG, all from one Remotion bundle, then laid over its
    // clip by ffmpeg.
    const todoClips = todo.map(({ clip }) => clip);
    // Tightened, a clip keeps only some pieces of its stretch of the source, and its captions are timed to match.
    const tightened = new Map<string, ReturnType<typeof tightenClip>>();
    if (project.tightenPacing) {
      if (!words) throw new Error("tightening the pacing needs the transcript's words");
      for (const clip of todoClips) tightened.set(clip.clipId, tightenClip(words, clip.start, clip.length));
    }
    const captionWords = project.withCaptions ? words : null;
    const titles = titleStills(project, todoClips, path.join(workDir, "titles"));
    const drawing = Boolean(captionWords) || titles.stills.length > 0;
    if (drawing && !resumeLabel) await step(captionWords ? "Drawing captions" : "Drawing the hook and end card");
    const overlays = !drawing
      ? null
      : await withCaptionBundle(async (serveUrl: string) => {
          const lists = !captionWords
            ? null
            : await captionOverlays(
                captionLines(captionWords),
                todoClips.map((clip) => {
                  const cut = tightened.get(clip.clipId);
                  return cut ? { clipId: clip.clipId, start: 0, length: cut.length, lines: captionLines(cut.words) } : clip;
                }),
                path.join(workDir, "captions"),
                project,
                serveUrl,
              );
          await drawTitleStills(titles.stills, path.join(workDir, "titles"), project, serveUrl);
          return lists;
        });
    const options = finishOptions(project);
    const cropMode = parseCropMode(project.crop);
    // Following the action finds each clip's subjects with the face and object models, loaded once for the render.
    const detectors =
      cropMode === "follow" ? await loadDetectors({ faceModel: requireEnv("YUNET_MODEL"), objectModel: requireEnv("YOLOX_MODEL") }) : null;

    for (const { index, clip } of todo) {
      await step(resume ? resumeStep(index + 1, total) : `Making clip ${index + 1} of ${total}`);
      const { clipId } = clip;
      const cut = tightened.get(clipId) ?? null;
      // On the source's time, before tightening, so a tightened clip's picture follows what it keeps.
      const crop: Crop = detectors
        ? await followCrop({ input: sourcePath, start: clip.start, length: clip.length, detectors })
        : { mode: cropMode as "centre" | "fit" };
      const finished = await finishClip({
        input: sourcePath,
        output: path.join(workDir, `${clipId}.mp4`),
        start: clip.start,
        length: clip.length,
        overlay: overlays?.get(clipId) ?? null,
        hook: titles.hooks.get(clipId) ?? null,
        endCard: titles.endCard,
        tightened: cut,
        crop,
        options,
      });

      // The key comes from the planned clip id, so a clip uploaded just before an interruption is overwritten.
      const storageKey = buildClipKey(projectId, clipId);
      await store.upload(storageKey, finished, "video/mp4");
      // A captioned clip keeps its words and its cut without captions, so its captions can be edited and drawn again.
      // Tightened, both are the tightened clip's: the words in its time, without the cut fillers. The cut has the clip's
      // crop, so captions drawn again over it show the same picture.
      let baseKey: string | null = null;
      if (captionWords) {
        const base = path.join(workDir, `${clipId}-base.mp4`);
        await renderClip({ input: sourcePath, output: base, start: clip.start, length: clip.length, overlay: null, tightened: cut, crop });
        baseKey = buildClipBaseKey(projectId, clipId);
        await store.upload(baseKey, base, "video/mp4");
      }
      await db.clip.create({
        data: {
          id: clipId,
          projectId,
          name: clipName(index),
          start: clip.start,
          length: cut ? cut.length : clip.length,
          storageKey,
          title: clip.title ?? null,
          musicTrack: project.musicTrack,
          words: !captionWords
            ? Prisma.DbNull
            : cut
              ? clipWords(cut.words, 0, cut.length)
              : clipWords(captionWords, clip.start, clip.length),
          baseKey,
        },
      });
    }

    await write({ status: "done", error: null, renderStep: null });
  } catch (err) {
    if (err instanceof RenderCancelled) {
      // Cancelled with no clips made, the project went back to ready; a clip finished since then makes it done.
      await db.clipProject.updateMany({ where: { id: projectId, status: "ready", renderId: null, clips: { some: {} } }, data: { status: "done" } });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await db.clipProject.updateMany({ where: { id: projectId, renderId }, data: { status: "failed", error: message, renderStep: null } });
    throw err;
  }
}

// Draws every caption of the project and returns, per clip, the ffconcat list that times its captions. Slideshows use
// it too. A clip with its own lines (a tightened clip, in its own time from 0) uses those instead of the project's.
export async function captionOverlays(
  lines: ReturnType<typeof captionLines>,
  highlights: { clipId: string; start: number; length: number; lines?: ReturnType<typeof captionLines> }[],
  dir: string,
  look: Pick<
    ClipProject,
    "captionPreset" | "captionPosition" | "captionUppercase" | "captionFont" | "captionHighlight" | "captionEmoji"
  >,
  serveUrl: string,
): Promise<Map<string, string>> {
  await mkdir(dir, { recursive: true });
  const { wordByWord } = captionPreset(look.captionPreset);
  const clips = highlights.map((highlight) => {
    const clipLines = captionsForClip(
      highlight.lines ?? lines,
      highlight.start * 1000,
      (highlight.start + highlight.length) * 1000,
    );
    const stills: { words: string[]; highlight: number | null; startMs: number; endMs: number }[] = captionStills(
      clipLines,
      wordByWord,
    );
    const overlays = stills.map((still, index) => ({
      words: still.words,
      highlight: still.highlight,
      emoji: look.captionEmoji ? lineEmoji(still.words) : null,
      image: path.join(dir, `${highlight.clipId}-${index}.png`),
      start: still.startMs / 1000,
      end: still.endMs / 1000,
    }));
    return { ...highlight, overlays };
  });
  await renderCaptionStills({
    serveUrl,
    stills: clips.flatMap((clip) =>
      clip.overlays.map(({ words, highlight, emoji, image }) => ({ words, highlight, emoji, output: image })),
    ),
    chromePath: requireEnv("CHROME_PATH"),
    preset: look.captionPreset,
    position: look.captionPosition,
    uppercase: look.captionUppercase,
    font: look.captionFont,
    highlightColor: look.captionHighlight,
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

async function drawTitleStills(
  stills: ReturnType<typeof titleStills>["stills"],
  dir: string,
  project: Pick<ClipProject, "captionFont">,
  serveUrl: string,
) {
  if (stills.length === 0) return;
  await mkdir(dir, { recursive: true });
  await renderTitleStills({ serveUrl, stills, chromePath: requireEnv("CHROME_PATH"), font: project.captionFont });
}

// Draws a clip's captions again from the words edited in its Captions tab (recaptionWords), over the cut it kept, with
// its project's caption look, hook, end card, progress bar and music, then replaces the clip's file with the next
// version. Cancelling clears the clip's recaption id: from then on its writes do not land and nothing is replaced.
export async function recaptionClip({
  db,
  store,
  clipId,
  recaptionId,
  workDir,
}: {
  db: PrismaClient;
  store: ClipStore;
  clipId: string;
  recaptionId: string;
  workDir: string;
}) {
  const clip = await db.clip.findUnique({ where: { id: clipId }, include: { project: true } });
  if (!clip) throw new Error(`clip ${clipId} not found`);
  // Cancelled before the job started.
  if (clip.recaptionId === null) return;
  if (clip.recaptionId !== recaptionId) throw new Error(`caption job for clip ${clipId} is for an earlier edit`);
  const { project } = clip;

  const write = async (data: Prisma.ClipUpdateManyMutationInput) => {
    const { count } = await db.clip.updateMany({ where: { id: clipId, recaptionId }, data });
    if (count === 0) throw new RenderCancelled();
  };
  const step = (recaptionStep: string) => write({ recaptionStep });

  try {
    if (!clip.baseKey) throw new Error(`clip ${clipId} has no cut kept without captions`);
    if (clip.recaptionWords === null) throw new Error(`clip ${clipId} has no edited words to draw`);
    const words = parseClipWords(clip.recaptionWords);
    const options = finishOptions(project);

    await step("Downloading the clip");
    const base = path.join(workDir, "base.mp4");
    await store.downloadTo(clip.baseKey, base);

    await step("Drawing captions");
    const planned: PlannedClip = { clipId, start: 0, length: clip.length, ...(clip.title ? { title: clip.title } : {}) };
    const titles = titleStills(project, [planned], path.join(workDir, "titles"));
    const overlays = await withCaptionBundle(async (serveUrl: string) => {
      const lists = await captionOverlays(clipLines(words), [planned], path.join(workDir, "captions"), project, serveUrl);
      await drawTitleStills(titles.stills, path.join(workDir, "titles"), project, serveUrl);
      return lists;
    });

    await step("Making the clip");
    const finished = await finishClip({
      input: base,
      output: path.join(workDir, "clip.mp4"),
      start: 0,
      length: clip.length,
      overlay: overlays.get(clipId) ?? null,
      hook: titles.hooks.get(clipId) ?? null,
      endCard: titles.endCard,
      tightened: null,
      crop: { mode: "centre" },
      options,
    });

    await step("Saving");
    const version = clip.version + 1;
    const storageKey = buildClipVersionKey(clip.projectId, clipId, version);
    await store.upload(storageKey, finished, "video/mp4");
    const { count } = await db.clip.updateMany({
      where: { id: clipId, recaptionId },
      data: {
        storageKey,
        version,
        words,
        musicTrack: project.musicTrack,
        recaptionId: null,
        recaptionStep: null,
        recaptionWords: Prisma.DbNull,
        recaptionError: null,
      },
    });
    if (count === 0) {
      await store.remove(storageKey);
      return;
    }
    await store.remove(clip.storageKey);
  } catch (err) {
    if (err instanceof RenderCancelled) return;
    const message = err instanceof Error ? err.message : String(err);
    await db.clip.updateMany({
      where: { id: clipId, recaptionId },
      data: { recaptionId: null, recaptionStep: null, recaptionWords: Prisma.DbNull, recaptionError: message },
    });
    throw err;
  }
}

// The hook titles and the end card to draw for the clips: the stills, which clip shows which hook, and the end card
// every clip ends with (or null). A clip without a title has no hook when the hook shows the clip's title.
function titleStills(
  project: Pick<ClipProject, "hookMode" | "hookText" | "endCardText">,
  clips: PlannedClip[],
  dir: string,
) {
  const stills: { kind: "hook" | "endCard"; text: string; output: string }[] = [];
  const hooks = new Map<string, string>();
  if (project.hookMode === "text") {
    if (!project.hookText) throw new Error("the hook shows the project's hook title, but it has none");
    const output = path.join(dir, "hook.png");
    stills.push({ kind: "hook", text: project.hookText, output });
    for (const clip of clips) hooks.set(clip.clipId, output);
  } else if (project.hookMode === "clipTitle") {
    for (const clip of clips) {
      if (!clip.title) continue;
      const output = path.join(dir, `${clip.clipId}-hook.png`);
      stills.push({ kind: "hook", text: clip.title, output });
      hooks.set(clip.clipId, output);
    }
  } else if (project.hookMode !== "off") {
    throw new Error(`unknown hook mode "${project.hookMode}"`);
  }
  const endCard = project.endCardText ? path.join(dir, "end-card.png") : null;
  if (endCard && project.endCardText) stills.push({ kind: "endCard", text: project.endCardText, output: endCard });
  return { stills, hooks, endCard };
}
