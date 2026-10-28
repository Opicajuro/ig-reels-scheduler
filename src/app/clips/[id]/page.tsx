import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { describeClipProject } from "@/lib/clip-status";
import { prisma } from "@/lib/prisma";
import { presignDownload } from "@/lib/storage";
import { Alert } from "@/components/alert";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import {
  copyProjectAction,
  deleteProjectAction,
  renameProjectAction,
  startRenderAction,
} from "../actions";
import { RefreshWhileRendering } from "../refresh-while-rendering";
import styles from "../clips.module.css";
import { ClipGrid } from "./clip-grid";

export const metadata: Metadata = { title: "Clip project" };

const CLIP_LENGTHS = [15, 30, 60, 90, 120];
const CLIP_COUNTS = Array.from({ length: 10 }, (_, index) => index + 1);
const CAPTION_STYLES = [
  { value: "classic", label: "Classic", hint: "White text, soft shadow" },
  { value: "yellow", label: "Yellow", hint: "Bold, black outline" },
  { value: "box", label: "Box", hint: "White on a dark panel" },
];
const CAPTION_POSITIONS = [
  { value: "bottom", label: "Bottom" },
  { value: "middle", label: "Middle" },
  { value: "top", label: "Top" },
];

export default async function ClipProjectPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const ownerId = await getOwnerId();
  const { id } = await params;

  const project = await prisma.clipProject.findFirst({
    where: { id, ownerId },
    include: { clips: { orderBy: { createdAt: "asc" } } },
  });
  if (!project) notFound();

  const accounts = await prisma.igAccount.findMany({
    where: { ownerId, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  // Accounts that already have a live post made from this project, for the duplicate-content warning.
  const livePosts = await prisma.post.findMany({
    where: {
      media: { sourceProjectId: project.id },
      status: { in: ["scheduled", "container_created", "published"] },
    },
    select: { account: { select: { username: true } } },
  });
  const alreadyScheduledTo = [...new Set(livePosts.map((post) => `@${post.account.username}`))];
  const clips = await Promise.all(
    project.clips.map(async (clip) => ({
      id: clip.id,
      name: clip.name,
      start: clip.start,
      length: clip.length,
      title: clip.title,
      description: clip.description,
      downloadUrl: await presignDownload(clip.storageKey, 3600),
    })),
  );

  const busy = project.status === "rendering";
  const waiting = project.status === "awaiting_source";
  const preset = project.captionPreset ?? "classic";
  const failed = project.status === "failed";
  const summary = describeClipProject({ status: project.status, error: project.error, clipCount: clips.length });
  const sourceLength = project.durationSeconds
    ? `Source ${Math.floor(project.durationSeconds / 60)}:${String(project.durationSeconds % 60).padStart(2, "0")}`
    : null;

  return (
    <main className={styles.page}>
      <Link href="/clips" className={styles.back}>
        ← All projects
      </Link>

      <PageHeader
        title={project.name}
        description={failed ? sourceLength : [sourceLength, summary].filter(Boolean).join(" · ")}
        actions={
          <>
            <ActionForm action={renameProjectAction} className={styles.actions}>
              <input type="hidden" name="projectId" value={project.id} />
              <input type="text" name="name" defaultValue={project.name} maxLength={120} required disabled={busy} />
              <SubmitButton disabled={busy} pendingLabel="Renaming…">
                Rename
              </SubmitButton>
            </ActionForm>
            <ActionForm action={copyProjectAction}>
              <input type="hidden" name="projectId" value={project.id} />
              <SubmitButton disabled={busy || waiting} pendingLabel="Copying…">
                Copy
              </SubmitButton>
            </ActionForm>
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

      <div className={styles.project}>
        <Card>
          <ActionForm
            className={styles.panel}
            action={startRenderAction}
            confirm={
              clips.length > 0
                ? {
                    message: `Making clips again replaces ${clips.length === 1 ? "the current clip" : `the ${clips.length} current clips`} and the titles and descriptions you edited. Continue?`,
                    confirmLabel: "Replace clips",
                  }
                : undefined
            }
          >
            <input type="hidden" name="projectId" value={project.id} />
            <h2>Make clips</h2>
            <span className={styles.label}>Clip length (seconds)</span>
            <div className={styles.choice}>
              {CLIP_LENGTHS.map((seconds) => (
                <label key={seconds} className={styles.pill}>
                  <input type="radio" name="clipSeconds" value={seconds} defaultChecked={seconds === project.clipSeconds} />
                  <span>{seconds} s</span>
                </label>
              ))}
            </div>
            <Field
              label="Number of clips"
              hint="Auto makes as many clips as the video allows. Each clip ends on a quiet moment, so it can run a little longer than the length you pick. Fewer clips are made if the video is short."
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
            <label className={styles.toggle}>
              <span>Burn in captions</span>
              <input type="checkbox" name="withCaptions" defaultChecked={project.withCaptions} />
            </label>
            <span className={styles.label}>Caption style</span>
            <div className={styles.choice}>
              {CAPTION_STYLES.map((style) => (
                <label key={style.value} className={styles.card}>
                  <input type="radio" name="captionPreset" value={style.value} defaultChecked={style.value === preset} />
                  <span className={`${styles.swatch} ${style.value === "yellow" ? styles.yellow : ""} ${style.value === "box" ? styles.box : ""}`}>Aa</span>
                  <div>
                    <span>{style.label}</span>
                    <small>{style.hint}</small>
                  </div>
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
            <SubmitButton variant="primary" disabled={busy || waiting} pendingLabel="Starting…">
              Make clips
            </SubmitButton>
          </ActionForm>
        </Card>

        <section>
          <h2>Clips</h2>
          <ClipGrid
            projectId={project.id}
            busy={busy}
            clips={clips}
            accounts={accounts.map((account) => ({ id: account.id, username: account.username }))}
            alreadyScheduledTo={alreadyScheduledTo}
          />
        </section>
      </div>
      {busy ? <RefreshWhileRendering /> : null}
    </main>
  );
}
