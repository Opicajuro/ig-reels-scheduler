import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { LocalTime } from "@/components/local-time";
import { StatusBadge } from "@/components/status-badge";
import { prisma } from "@/lib/prisma";
import { MAX_SLIDES, MAX_TOPIC_LENGTH, MIN_SLIDES, type Slide } from "@/lib/slideshow-options";
import { getSlideshowEngine } from "@/lib/slideshow-engines";
import { presignDownload } from "@/lib/storage";
import aiStyles from "./ai.module.css";
import styles from "./clips.module.css";
import { SlideshowEditor, type FrameMedia } from "./slideshow-editor";
import { SlideshowProgress } from "./slideshow-progress";
import { writeScriptAction } from "./slideshow-actions";
import slideshowStyles from "./slideshow.module.css";

const RECENT_SLIDESHOWS = 10;
const FRAME_CLIPS = 50;
const FRAME_VIDEOS = 20;
const SLIDE_COUNTS = Array.from({ length: MAX_SLIDES - MIN_SLIDES + 1 }, (_, index) => MIN_SLIDES + index);

// The Slideshow tab: a topic for the script writer, then each slideshow as it is written, edited and made.
export async function SlideshowTab({ ownerId }: { ownerId: string }) {
  const [script, picture] = await Promise.all([getSlideshowEngine(prisma, "script"), getSlideshowEngine(prisma, "picture")]);
  const jobs = await prisma.slideshowJob.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
    take: RECENT_SLIDESHOWS,
    include: { clip: { select: { projectId: true, name: true } } },
  });
  const editable = jobs.filter((job) => job.status === "draft" || (job.status === "failed" && job.slides !== null));
  const media = editable.length > 0 ? await frameMedia(ownerId) : [];

  return (
    <div className={slideshowStyles.tab}>
      <Card>
        <div className={styles.panel}>
          <h2>New slideshow</h2>
          <p className={styles.muted}>
            Pictures that slowly zoom and pan, with a voice and captions, made on this PC without the internet. Works on
            any PC.
          </p>
          {script.status === "installed" ? (
            <ActionForm action={writeScriptAction} className={aiStyles.form}>
              <Field label="What is it about?" hint="A topic, a message or a short story. English works best.">
                <input name="topic" maxLength={MAX_TOPIC_LENGTH} required placeholder="Three tips for better sleep" />
              </Field>
              <Field label="Slides">
                <select name="slideCount" defaultValue={5}>
                  {SLIDE_COUNTS.map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </Field>
              <SubmitButton variant="primary" pendingLabel="Starting…">
                Write script
              </SubmitButton>
            </ActionForm>
          ) : (
            <p className={styles.muted}>
              The script writer is not installed yet. <Link href="/settings#slideshow-ai">Set it up in Settings</Link>
            </p>
          )}
        </div>
      </Card>

      {jobs.length > 0 ? (
        <ul className={aiStyles.jobs}>
          {jobs.map((job) => (
            <li key={job.id}>
              <p className={aiStyles.prompt}>{job.topic}</p>
              <div className={aiStyles.jobMeta}>
                {job.status === "writing" || job.status === "queued" || job.status === "running" ? (
                  <SlideshowProgress jobId={job.id} initialStatus={job.status} initialStep={job.step} />
                ) : (
                  <StatusBadge status={job.status} label={job.status === "done" ? "Done" : undefined} />
                )}
                <span className={aiStyles.meta}>
                  {job.slideCount} slides · <LocalTime date={job.createdAt} />
                </span>
                {job.clip ? <Link href={`/clips/${job.clip.projectId}`}>Open {job.clip.name} in Slideshows</Link> : null}
              </div>
              {job.status === "failed" ? <Alert tone="error">{job.error}</Alert> : null}
              {editable.includes(job) ? (
                <SlideshowEditor
                  jobId={job.id}
                  initialSlides={job.slides as Slide[]}
                  initialVoice={job.voice}
                  initialCaptionPreset={job.captionPreset}
                  media={media}
                  canDraw={picture.status === "installed"}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The owner's recent clips and source videos, to take a slide's picture from.
async function frameMedia(ownerId: string): Promise<FrameMedia[]> {
  const [clips, videos] = await Promise.all([
    prisma.clip.findMany({
      where: { project: { ownerId } },
      orderBy: { createdAt: "desc" },
      take: FRAME_CLIPS,
      select: { id: true, name: true, length: true, storageKey: true, project: { select: { name: true } } },
    }),
    prisma.clipProject.findMany({
      where: { ownerId, sourceKey: { not: null }, durationSeconds: { not: null } },
      orderBy: { createdAt: "desc" },
      take: FRAME_VIDEOS,
      select: { id: true, name: true, durationSeconds: true, sourceKey: true },
    }),
  ]);
  return [
    ...(await Promise.all(
      clips.map(async (clip) => ({
        kind: "clip" as const,
        id: clip.id,
        label: `${clip.project.name} · ${clip.name}`,
        length: clip.length,
        url: await presignDownload(clip.storageKey, 3600),
      })),
    )),
    ...(await Promise.all(
      videos.map(async (video) => ({
        kind: "video" as const,
        id: video.id,
        label: `${video.name} · whole video`,
        length: video.durationSeconds!,
        url: await presignDownload(video.sourceKey!, 3600),
      })),
    )),
  ];
}
