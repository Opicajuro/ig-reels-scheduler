import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { describeClipProject } from "@/lib/clip-status";
import { prisma } from "@/lib/prisma";
import { presignDownload } from "@/lib/storage";
import {
  copyProjectAction,
  deleteProjectAction,
  renameProjectAction,
  startRenderAction,
} from "../actions";
import { ConfirmForm } from "../confirm-form";
import { RefreshWhileRendering } from "../refresh-while-rendering";
import styles from "../clips.module.css";
import { ClipGrid } from "./clip-grid";

const CLIP_LENGTHS = [15, 30, 60, 90, 120];
const CLIP_COUNTS = Array.from({ length: 10 }, (_, index) => index + 1);
const CAPTION_STYLES = [
  { value: "classic", label: "Classic", hint: "White text, soft shadow" },
  { value: "yellow", label: "Yellow", hint: "Bold, black outline" },
  { value: "box", label: "Box", hint: "White on a dark panel" },
];

async function ProjectView({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const ownerId = session.user.id;
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

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <header className={styles.top}>
          <Link href="/" className={styles.brand}>
            Local<b>irs</b>
          </Link>
          <Link href="/dashboard">Dashboard</Link>
        </header>

        <Link href="/clips" className={styles.back}>
          ← All projects
        </Link>

        <div className={styles.head}>
          <div>
            <h1>{project.name}</h1>
            <p className={styles.meta}>
              {project.durationSeconds ? `Source ${Math.floor(project.durationSeconds / 60)}:${String(project.durationSeconds % 60).padStart(2, "0")} · ` : ""}
              {describeClipProject({ status: project.status, error: project.error, clipCount: clips.length })}
            </p>
          </div>
          <div className={styles.actions}>
            <form action={renameProjectAction} className={styles.actions}>
              <input type="hidden" name="projectId" value={project.id} />
              <input type="text" name="name" defaultValue={project.name} maxLength={120} required disabled={busy} />
              <button type="submit" disabled={busy}>
                Rename
              </button>
            </form>
            <form action={copyProjectAction}>
              <input type="hidden" name="projectId" value={project.id} />
              <button type="submit" disabled={busy || waiting}>
                Copy
              </button>
            </form>
            <ConfirmForm
              action={deleteProjectAction}
              message={`Delete "${project.name}" and all its clips? This cannot be undone.`}
              fields={{ projectId: project.id }}
              disabled={busy}
            >
              Delete
            </ConfirmForm>
          </div>
        </div>

        <div className={styles.project}>
          <form className={styles.panel} action={startRenderAction}>
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
            <span className={styles.label}>Number of clips</span>
            <select name="clipCount" defaultValue={project.clipCount}>
              {CLIP_COUNTS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
            <p className={styles.muted}>
              Each clip ends on a quiet moment, so it can run a little longer than the length you pick. Fewer clips are made if the video is short.
            </p>
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
            <button type="submit" className={styles.primary} disabled={busy || waiting}>
              Make clips
            </button>
          </form>

          <section>
            <h2>Clips</h2>
            <ClipGrid
              projectId={project.id}
              busy={busy}
              clips={clips}
              accounts={accounts.map((account) => ({ id: account.id, username: account.username }))}
            />
          </section>
        </div>
        {busy ? <RefreshWhileRendering /> : null}
      </div>
    </div>
  );
}

export default function ClipProjectPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <ProjectView params={params} />
    </Suspense>
  );
}
