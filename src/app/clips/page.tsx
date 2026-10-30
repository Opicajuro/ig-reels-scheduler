import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Tabs } from "@/components/tabs";
import { getAiEngine } from "@/lib/ai-engine";
import { checkGpu } from "@/lib/ai-gpu";
import { MAX_PROMPT_LENGTH } from "@/lib/ai-video";
import { getOwnerId } from "@/lib/owner";
import { describeClipProject } from "@/lib/clip-status";
import { prisma } from "@/lib/prisma";
import { createLinkProjectAction } from "./actions";
import aiStyles from "./ai.module.css";
import styles from "./clips.module.css";
import { NewVideoForm } from "./new-video-form";
import { SourceLink } from "./source-link";
import { UploadForm } from "./upload-form";
import { VideoProgress } from "./video-progress";

export const metadata: Metadata = { title: "Clips" };

const RECENT_VIDEOS = 10;

export default async function ClipsPage() {
  await connection();
  const ownerId = await getOwnerId();

  const projects = await prisma.clipProject.findMany({
    where: { ownerId: ownerId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { clips: true } } },
  });
  const jobs = await prisma.aiVideoJob.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
    take: RECENT_VIDEOS,
    include: { clip: { select: { projectId: true, name: true, project: { select: { name: true } } } } },
  });

  return (
    <main className={styles.page}>
      <PageHeader title="Clips" description="Cut a long video into vertical clips, or make one from a description." />
      <Tabs
        label="New clips"
        tabs={[
          {
            id: "video",
            label: "From a video",
            content: (
              <div className={styles.grid2}>
                <UploadForm />
                <Card>
                  <ActionForm className={styles.panel} action={createLinkProjectAction}>
                    <h2>Or paste a video link</h2>
                    <p className={styles.muted}>Works with links yt-dlp can download. Only use videos you have the rights to.</p>
                    <input type="text" name="name" placeholder="Project name" maxLength={120} required />
                    <input type="url" name="url" placeholder="https://…" required />
                    <SubmitButton variant="primary" pendingLabel="Creating…">
                      Create project from link
                    </SubmitButton>
                  </ActionForm>
                </Card>
              </div>
            ),
          },
          { id: "ai", label: "From a description (AI)", content: <AiVideoCard /> },
        ]}
      />

      {jobs.length > 0 ? (
        <section>
          <h2>Recent AI videos</h2>
          <ul className={aiStyles.jobs}>
            {jobs.map((job) => (
              <li key={job.id}>
                <p className={aiStyles.prompt}>{job.prompt}</p>
                <div className={aiStyles.jobMeta}>
                  {job.status === "queued" || job.status === "running" ? (
                    <VideoProgress jobId={job.id} initialStatus={job.status} initialStep={job.step} />
                  ) : (
                    <StatusBadge status={job.status} label={job.status === "done" ? "Done" : undefined} />
                  )}
                  <span className={aiStyles.meta}>
                    {job.seconds} s{job.startImageKey ? " · from a picture" : ""} · <LocalTime date={job.createdAt} />
                  </span>
                  {job.clip ? (
                    <Link href={`/clips/${job.clip.projectId}`}>
                      Open {job.clip.name} in {job.clip.project.name}
                    </Link>
                  ) : null}
                </div>
                {job.status === "failed" ? <Alert tone="error">{job.error}</Alert> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <h2>Projects</h2>
      {projects.length === 0 ? (
        <EmptyState>No projects yet.</EmptyState>
      ) : (
        <ul className={styles.projects}>
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/clips/${project.id}`} className={styles.projectLink}>
                <strong>{project.name}</strong>
                <span className={styles.meta}>
                  {describeClipProject({ status: project.status, error: project.error, clipCount: project._count.clips })}
                </span>
              </Link>
              {project.aiVideos ? null : (
                <span className={styles.source}>
                  <SourceLink sourceUrl={project.sourceUrl} />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// The AI tab: the new-video form once this PC's graphics card is good enough and the engine is installed. Both are
// set up in Settings, so otherwise it says what is missing and links there.
async function AiVideoCard() {
  const gpu = await checkGpu();

  return (
    <Card>
      <div className={styles.panel}>
        <h2>New AI video</h2>
        <p className={styles.muted}>Made on this PC by its graphics card, without the internet.</p>
        {!gpu.found ? (
          <>
            <Alert tone="error">{gpu.reason}</Alert>
            <p className={styles.muted}>
              AI videos need an NVIDIA graphics card with at least 12 GB of video memory.{" "}
              <Link href="/settings#ai-video">See AI video in Settings</Link>
            </p>
          </>
        ) : !gpu.ready ? (
          <>
            <Alert tone="error">This graphics card has too little video memory for AI videos. They need at least 12 GB.</Alert>
            <p className={styles.muted}>
              <Link href="/settings#ai-video">See AI video in Settings</Link>
            </p>
          </>
        ) : (
          <AiVideoForm />
        )}
      </div>
    </Card>
  );
}

async function AiVideoForm() {
  const engine = await getAiEngine(prisma);
  if (engine.status === "installed") return <NewVideoForm maxPromptLength={MAX_PROMPT_LENGTH} />;
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
