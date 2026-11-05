import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { describeClipProject } from "@/lib/clip-status";
import { loadPublishedStats } from "@/lib/published-stats";
import { prisma } from "@/lib/prisma";
import { presignDownload } from "@/lib/storage";
import { Alert } from "@/components/alert";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/field";
import { MusicPicker } from "@/components/music-picker";
import { PageHeader } from "@/components/page-header";
import { SourceLink } from "../source-link";
import {
  copyProjectAction,
  deleteProjectAction,
  discardHighlightsAction,
  startRenderAction,
} from "../actions";
import { RenderProgress } from "../render-progress";
import styles from "../clips.module.css";
import { ClipGrid } from "./clip-grid";
import { HighlightReview } from "./highlight-review";
import { ProjectTitle } from "./project-title";
import { VIDEO_COLOR_NAMES, videoColor } from "@/clip-engine/remotion/caption-presets.js";
import { END_CARD_TEXT_MAX, HOOK_TEXT_MAX } from "@/clip-engine/helpers.js";
import { parseClipWords } from "@/lib/caption-words";
import { parseClipSounds } from "@/lib/clip-sounds";
import { AutoSoundsPicker } from "@/components/sound-effects";
import { lengthLimits, parseTranscript, validateHighlights, wordsInRange } from "@/lib/highlights";
import { NoAiGpuNote } from "@/components/no-ai-gpu-note";
import { getAiEngine } from "@/lib/ai-engine";
import { checkGpu } from "@/lib/ai-gpu";
import { MAX_PROMPT_LENGTH } from "@/lib/ai-video";
import { SOURCE_DELETED } from "@/lib/storage-messages";
import { parseSuggestion } from "@/lib/clip-writer";
import { getSlideshowEngine } from "@/lib/slideshow-engines";

export const metadata: Metadata = { title: "Clip project" };

const CLIP_LENGTHS = [15, 30, 60, 90, 120];
const CLIP_COUNTS = Array.from({ length: 10 }, (_, index) => index + 1);
const CROPS = [
  { value: "centre", label: "Centre", hint: "The middle of the video." },
  {
    value: "follow",
    label: "Follow the action",
    hint: "Follows faces, then people and objects, then movement, panning smoothly. Stretches too wide for the frame show whole.",
  },
  { value: "fit", label: "Fit whole frame", hint: "The whole video over a blurred fill of itself." },
];
const CAPTION_STYLES = [
  { value: "classic", label: "Classic", hint: "White text, soft shadow" },
  { value: "yellow", label: "Yellow", hint: "Bold, black outline" },
  { value: "box", label: "Box", hint: "White on a dark panel" },
  { value: "words", label: "Word by word", hint: "The spoken word lights up" },
];
const CAPTION_POSITIONS = [
  { value: "bottom", label: "Bottom" },
  { value: "middle", label: "Middle" },
  { value: "top", label: "Top" },
];

const CAPTION_FONTS = [
  { value: "default", label: "Standard" },
  { value: "montserrat", label: "Montserrat" },
  { value: "anton", label: "Anton" },
  { value: "bebas", label: "Bebas Neue" },
];
const HOOK_MODES = [
  { value: "off", label: "None" },
  { value: "text", label: "Hook text" },
  { value: "clipTitle", label: "Use clip title" },
];

// A colour burned into the video, shown as a dot of that colour.
function ColorDot({ name }: { name: string }) {
  return <span className={styles.colorDot} style={{ "--dot": videoColor(name) } as CSSProperties} />;
}

const SETTINGS_FORM = "clip-settings";

// The highlights waiting for review, with what the timeline needs. They were checked against the video when found.
async function reviewState(project: {
  durationSeconds: number | null;
  highlights: unknown;
  sourceKey: string | null;
  transcript: unknown;
}) {
  if (project.durationSeconds === null || !project.sourceKey) throw new Error("highlights to review without a stored video");
  return {
    durationSeconds: project.durationSeconds,
    highlights: validateHighlights(project.highlights, project.durationSeconds),
    limits: lengthLimits(project.durationSeconds),
    sourceUrl: await presignDownload(project.sourceKey, 3600),
    words: project.transcript === null ? null : parseTranscript(project.transcript),
  };
}

// Every project that is making clips has a start time: "Make clips" sets it, and the migration that added it set it
// for projects already rendering.
function renderStartedAt(startedAt: Date | null): Date {
  if (!startedAt) throw new Error("a project that is making clips has no start time");
  return startedAt;
}

// Why the clips' AI intro and B-roll cannot be made on this PC, said as on the Clips page, or null when they can.
async function aiUnavailable() {
  const gpu = await checkGpu();
  if (!gpu.found || !gpu.ready) {
    return (
      <>
        <NoAiGpuNote check={gpu} />
        <p className={styles.muted}>
          <Link href="/settings#ai-video">See AI video in Settings</Link>
        </p>
      </>
    );
  }
  const engine = await getAiEngine(prisma);
  if (engine.status === "installed") return null;
  const state = {
    not_installed: "The AI video engine is not installed yet.",
    installing: "The AI video engine is being installed.",
    failed: "The AI video engine install stopped.",
  }[engine.status];
  return (
    <p className={styles.muted}>
      {state} <Link href="/settings#ai-video">Set it up in Settings</Link>
    </p>
  );
}

const FIRST_WORDS = 12;

export default async function ClipProjectPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const ownerId = await getOwnerId();
  const { id } = await params;

  const project = await prisma.clipProject.findFirst({
    where: { id, ownerId },
    include: {
      clips: {
        orderBy: { createdAt: "asc" },
        include: { links: { orderBy: { createdAt: "asc" }, select: { id: true, url: true } } },
      },
    },
  });
  if (!project) notFound();

  // The other projects, for moving or copying clips to.
  const otherProjects = await prisma.clipProject.findMany({
    where: { ownerId, id: { not: project.id } },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true },
  });
  const accounts = await prisma.igAccount.findMany({
    where: { ownerId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  const [ytChannels, fbPages, ttAccounts] = await Promise.all([
    prisma.ytAccount.findMany({ where: { ownerId, status: "active" }, orderBy: { createdAt: "asc" } }),
    prisma.fbPage.findMany({ where: { ownerId, status: "active" }, orderBy: { createdAt: "asc" } }),
    prisma.ttAccount.findMany({ where: { ownerId, status: "active" }, orderBy: { createdAt: "asc" } }),
  ]);
  const channels = [
    ...ytChannels.map((channel) => ({ id: channel.id, title: channel.channelTitle, platform: "youtube" as const })),
    ...fbPages.map((page) => ({ id: page.id, title: page.name, platform: "facebook" as const })),
    ...ttAccounts.map((account) => ({ id: account.id, title: account.displayName, platform: "tiktok" as const })),
  ];
  // Accounts that already have a live post made from this project, for the duplicate-content warning.
  const livePosts = await prisma.post.findMany({
    where: {
      media: { sourceProjectId: project.id },
      status: { in: ["scheduled", "container_created", "published"] },
    },
    select: { account: { select: { username: true } } },
  });
  // Published posts with views, for "Use best time".
  const bestTimeSamples = (await loadPublishedStats(prisma, ownerId)).flatMap((post) =>
    post.metrics.views === undefined
      ? []
      : [{ accountId: post.accountId, at: post.publishedAt.toISOString(), views: post.metrics.views }],
  );
  const alreadyScheduledTo = [...new Set(livePosts.map((post) => `@${post.account.username}`))];
  const transcript = project.transcript === null ? [] : parseTranscript(project.transcript);
  const clips = await Promise.all(
    project.clips.map(async (clip) => ({
      id: clip.id,
      name: clip.name,
      start: clip.start,
      length: clip.length,
      title: clip.title,
      description: clip.description,
      aiGenerated: clip.aiGenerated,
      musicTrack: clip.musicTrack,
      links: clip.links,
      downloadUrl: await presignDownload(clip.storageKey, 3600),
      version: clip.version,
      words: clip.recaptionWords !== null ? parseClipWords(clip.recaptionWords) : clip.words === null ? null : parseClipWords(clip.words),
      baseCutRemoved: clip.words !== null && clip.baseKey === null,
      baseCut: clip.baseKey !== null,
      sounds: parseClipSounds(clip.recaptionSounds ?? clip.sounds ?? [], clip.length),
      recaption: clip.recaptionId ? { step: clip.recaptionStep } : null,
      recaptionError: clip.recaptionError,
      firstWords: wordsInRange(transcript, clip).split(" ").slice(0, FIRST_WORDS).join(" "),
      writer: clip.aiWriteId ? { step: clip.aiWriteStep } : null,
      suggestion: clip.aiSuggestion === null ? null : parseSuggestion(clip.aiSuggestion),
      writeError: clip.aiWriteError,
    })),
  );

  // The AI videos and Slideshows projects have no source video: their clips are made on the Clips page.
  const noSource = project.aiVideos || project.slideshows;
  const busy = project.status === "rendering" || project.status === "picking";
  const review = project.status === "review" ? await reviewState(project) : null;
  const waiting = project.status === "awaiting_source";
  const sourceDeleted = project.sourceDeletedAt !== null;
  const preset = project.captionPreset ?? "classic";
  const failed = project.status === "failed";
  const summary = describeClipProject({ status: project.status, error: project.error, renderStep: project.renderStep, clipCount: clips.length });
  const sourceLength = project.durationSeconds
    ? `Source ${Math.floor(project.durationSeconds / 60)}:${String(project.durationSeconds % 60).padStart(2, "0")}`
    : null;
  const facts = (failed ? [sourceLength] : [sourceLength, summary]).filter(Boolean).join(" · ");

  return (
    <main className={styles.page}>
      <Link href="/clips" className={styles.back}>
        ← All projects
      </Link>

      <PageHeader
        title={<ProjectTitle projectId={project.id} name={project.name} busy={busy} />}
        description={
          noSource ? (
            facts
          ) : (
            <>
              <SourceLink sourceUrl={project.sourceUrl} />
              {facts ? ` · ${facts}` : null}
            </>
          )
        }
        actions={
          <>
            {noSource ? null : (
              <ActionForm action={copyProjectAction}>
                <input type="hidden" name="projectId" value={project.id} />
                <SubmitButton disabled={busy || waiting} pendingLabel="Copying…">
                  Copy
                </SubmitButton>
              </ActionForm>
            )}
            <ActionForm
              action={deleteProjectAction}
              confirm={{
                message: `Delete "${project.name}" and all its clips? This cannot be undone.`,
                confirmLabel: "Delete project",
              }}
            >
              <input type="hidden" name="projectId" value={project.id} />
              <SubmitButton variant="danger" disabled={busy} pendingLabel="Deleting…">
                Delete
              </SubmitButton>
            </ActionForm>
          </>
        }
      />
      {failed ? (
        <div className={styles.failure}>
          <Alert tone="error">{summary}</Alert>
        </div>
      ) : null}
      {sourceDeleted ? (
        <div className={styles.failure}>
          <Alert tone="info">
            {SOURCE_DELETED} <Link href="/storage">Storage</Link>
          </Alert>
        </div>
      ) : null}
      {busy ? (
        <RenderProgress
          projectId={project.id}
          status={project.status === "picking" ? "picking" : "rendering"}
          initialStep={project.renderStep}
          startedAt={renderStartedAt(project.renderStartedAt).toISOString()}
          initialClipsDone={project.clips.length}
        />
      ) : null}

      <div className={`${styles.project} ${noSource ? styles.single : ""}`}>
        {noSource ? null : (
          <ActionForm
            id={SETTINGS_FORM}
            className={styles.settings}
            action={startRenderAction}
            confirm={
              clips.length > 0
                ? {
                    message: `Making clips again replaces ${clips.length === 1 ? "the current clip" : `the ${clips.length} current clips`} and the titles, descriptions and captions you edited. A hook that uses the clip title keeps the titles. Continue?`,
                    confirmLabel: "Replace clips",
                  }
                : undefined
            }
          >
            <input type="hidden" name="projectId" value={project.id} />
            <div className={styles.panel}>
              <h2>Make clips</h2>
              <span className={styles.label}>Clip length (seconds)</span>
              <div className={styles.choice}>
                {CLIP_LENGTHS.map((seconds) => (
                  <label key={seconds} className={styles.pill}>
                    <input type="radio" name="clipSeconds" value={seconds} defaultChecked={seconds === project.clipSeconds} />
                    <span>{seconds}</span>
                  </label>
                ))}
              </div>
              <Field
                label="Number of clips"
                hint="Auto makes as many as the video allows. Clips end on a quiet moment or, once transcribed, a full sentence, so they can run a little long."
              >
                <select name="clipCount" defaultValue={project.clipCount ?? "auto"}>
                  <option value="auto">Auto</option>
                  {CLIP_COUNTS.map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </Field>
              <span className={styles.label}>Crop</span>
              <div className={styles.choice}>
                {CROPS.map((crop) => (
                  <label key={crop.value} className={styles.pill} title={crop.hint}>
                    <input type="radio" name="crop" value={crop.value} defaultChecked={crop.value === project.crop} />
                    <span>{crop.label}</span>
                  </label>
                ))}
              </div>
              <label className={styles.toggle} title="Pauses over 0.7 s shrink to 0.25 s and lone um, uh and erm are cut. The video is transcribed for this.">
                <span>Tighten pacing</span>
                <input type="checkbox" name="tightenPacing" defaultChecked={project.tightenPacing} />
              </label>
              <span className={styles.label}>Font</span>
              <div className={styles.choice}>
                {CAPTION_FONTS.map((font) => (
                  <label key={font.value} className={styles.pill}>
                    <input type="radio" name="captionFont" value={font.value} defaultChecked={font.value === project.captionFont} />
                    <span>{font.label}</span>
                  </label>
                ))}
              </div>
              <label className={styles.toggle}>
                <span>Burn in captions</span>
                <input type="checkbox" name="withCaptions" defaultChecked={project.withCaptions} />
              </label>
              <div className={styles.captionOptions}>
                <span className={styles.label}>Caption style</span>
                <div className={`${styles.choice} ${styles.styles}`}>
                  {CAPTION_STYLES.map((style) => (
                    <label key={style.value} className={styles.card} title={style.hint}>
                      <input type="radio" name="captionPreset" value={style.value} defaultChecked={style.value === preset} />
                      <span className={`${styles.swatch} ${style.value === "yellow" ? styles.yellow : ""} ${style.value === "box" ? styles.box : ""}`}>
                        {style.value === "words" ? <span>A<span className={styles.spokenWord}>a</span></span> : "Aa"}
                      </span>
                      <span>{style.label}</span>
                    </label>
                  ))}
                </div>
                <span className={styles.label}>Caption position</span>
                <div className={styles.choice}>
                  {CAPTION_POSITIONS.map((position) => (
                    <label key={position.value} className={styles.pill}>
                      <input
                        type="radio"
                        name="captionPosition"
                        value={position.value}
                        defaultChecked={position.value === project.captionPosition}
                      />
                      <span>{position.label}</span>
                    </label>
                  ))}
                </div>
                <label className={styles.toggle}>
                  <span>All capitals</span>
                  <input type="checkbox" name="captionUppercase" defaultChecked={project.captionUppercase} />
                </label>
                <span className={styles.label}>Word by word highlight</span>
                <div className={styles.choice}>
                  {VIDEO_COLOR_NAMES.map((name: string) => (
                    <label key={name} className={styles.pill} title={name}>
                      <input
                        type="radio"
                        name="captionHighlight"
                        value={name}
                        aria-label={name}
                        defaultChecked={name === project.captionHighlight}
                      />
                      <ColorDot name={name} />
                    </label>
                  ))}
                </div>
                <label className={styles.toggle}>
                  <span>An emoji on lines that suit one</span>
                  <input type="checkbox" name="captionEmoji" defaultChecked={project.captionEmoji} />
                </label>
              </div>
              <span className={styles.label}>Hook title, for the first 2 seconds</span>
              <div className={styles.choice}>
                {HOOK_MODES.map((mode) => (
                  <label key={mode.value} className={styles.pill}>
                    <input type="radio" name="hookMode" value={mode.value} defaultChecked={mode.value === project.hookMode} />
                    <span>{mode.label}</span>
                  </label>
                ))}
              </div>
              <p className={`${styles.muted} ${styles.hookTitleHint}`}>
                Each clip shows the title you gave it. Give the clips titles, then make clips again.
              </p>
              <div className={styles.hookText}>
                <Field label="Hook text" hint="Shown big at the top of every clip.">
                  <input type="text" name="hookText" maxLength={HOOK_TEXT_MAX} defaultValue={project.hookText ?? ""} />
                </Field>
              </div>
              <span className={styles.label}>Progress bar</span>
              <div className={styles.choice}>
                <label className={styles.pill}>
                  <input type="radio" name="progressBar" value="off" defaultChecked={project.progressBar === null} />
                  <span>Off</span>
                </label>
                {VIDEO_COLOR_NAMES.map((name: string) => (
                  <label key={name} className={styles.pill} title={name}>
                    <input
                      type="radio"
                      name="progressBar"
                      value={name}
                      aria-label={name}
                      defaultChecked={name === project.progressBar}
                    />
                    <ColorDot name={name} />
                  </label>
                ))}
              </div>
              <Field label="End card text" hint="Shown for the last 1.5 seconds, such as @myhandle. Leave empty for none.">
                <input type="text" name="endCardText" maxLength={END_CARD_TEXT_MAX} defaultValue={project.endCardText ?? ""} />
              </Field>
              <MusicPicker track={project.musicTrack} volume={project.musicVolume} />
              <span className={styles.label}>Sound effects</span>
              <AutoSoundsPicker sfxHook={project.sfxHook} sfxCaptions={project.sfxCaptions} sfxCuts={project.sfxCuts} />
            </div>
            <div className={styles.settingsFooter}>
              {review ? (
                <>
                  <SubmitButton variant="primary" name="intent" value="reviewed" disabled={busy} pendingLabel="Starting…">
                    Make clips
                  </SubmitButton>
                  <SubmitButton name="intent" value="pick" disabled={busy} pendingLabel="Starting…">
                    Find highlights again
                  </SubmitButton>
                </>
              ) : (
                <>
                  <label className={styles.toggle}>
                    <span>Review highlights before making clips</span>
                    <input type="checkbox" name="review" defaultChecked />
                  </label>
                  <SubmitButton variant="primary" disabled={busy || waiting || sourceDeleted} pendingLabel="Starting…">
                    <span className={styles.findLabel}>Find highlights</span>
                    <span className={styles.makeLabel}>Make clips</span>
                  </SubmitButton>
                </>
              )}
            </div>
          </ActionForm>
        )}

        <div className={styles.column}>
          {review ? (
            <div className={styles.reviewPanel}>
              <HighlightReview
                formId={SETTINGS_FORM}
                durationSeconds={review.durationSeconds}
                initial={review.highlights}
                limits={review.limits}
                clipSeconds={project.clipSeconds}
                sourceUrl={review.sourceUrl}
                words={review.words}
                tightenPacing={project.tightenPacing}
              />
              <ActionForm action={discardHighlightsAction}>
                <input type="hidden" name="projectId" value={project.id} />
                <SubmitButton size="sm" pendingLabel="Discarding…">
                  Discard highlights
                </SubmitButton>
              </ActionForm>
            </div>
          ) : null}
          <section>
            <h2>Clips</h2>
            <ClipGrid
              projectId={project.id}
              busy={busy}
              clips={clips}
              accounts={accounts.map((account) => ({ id: account.id, username: account.username }))}
              channels={channels}
              alreadyScheduledTo={alreadyScheduledTo}
              projects={otherProjects}
              bestTimeSamples={bestTimeSamples}
              captionsTab={!noSource}
              ai={{ unavailable: await aiUnavailable(), maxPromptLength: MAX_PROMPT_LENGTH }}
              writerInstalled={(await getSlideshowEngine(prisma, "script")).status === "installed"}
            />
          </section>
        </div>
      </div>
    </main>
  );
}
