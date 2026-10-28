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
import { AI_ENGINE, aiDir, downloadBytes, formatGigabytes, getAiEngine, requiredFreeBytes } from "@/lib/ai-engine";
import { checkGpu, formatVram } from "@/lib/ai-gpu";
import { MAX_PROMPT_LENGTH } from "@/lib/ai-video";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { installAiEngineAction, uninstallAiEngineAction } from "./actions";
import styles from "./ai.module.css";
import { EngineProgress } from "./engine-progress";
import { NewVideoForm } from "./new-video-form";
import { VideoProgress } from "./video-progress";

export const metadata: Metadata = { title: "AI clips" };

const RECENT_VIDEOS = 10;

export default async function AiPage() {
  await connection();
  const gpu = await checkGpu();
  const ready = gpu.found && gpu.ready;

  return (
    <main className={styles.page}>
      <PageHeader title="AI clips" description="Make short vertical videos from a description, on this PC, without the internet." />
      <Card>
        <div className={styles.stack}>
          <h2>This PC</h2>
          {gpu.found ? (
            <>
              <dl className={styles.facts}>
                <dt>Graphics card</dt>
                <dd>{gpu.gpu.name}</dd>
                <dt>Video memory</dt>
                <dd>{formatVram(gpu.gpu.vramMiB)}</dd>
                <dt>Driver</dt>
                <dd>{gpu.gpu.driver}</dd>
              </dl>
              {!gpu.ready ? (
                <Alert tone="error">This card has too little video memory for AI videos. They need at least 12 GB.</Alert>
              ) : gpu.recommended ? (
                <p className={styles.ok}>Ready for AI videos.</p>
              ) : (
                <p className={styles.warning}>Ready, but 16 GB of video memory is recommended: videos take longer on this card.</p>
              )}
            </>
          ) : (
            <Alert tone="error">{gpu.reason}</Alert>
          )}
          {ready ? null : (
            <p className={styles.note}>
              AI videos are made on this PC by an NVIDIA graphics card with at least 12 GB of video memory (16 GB
              recommended), such as a GeForce RTX 4070 Ti Super, 4080 or 5080. Without one, this page has nothing to set up.
            </p>
          )}
        </div>
      </Card>
      {ready ? <AiSections /> : null}
    </main>
  );
}

// The engine, the form and the recent videos: only shown on a PC whose card can make AI videos.
async function AiSections() {
  const ownerId = await getOwnerId();
  const engine = await getAiEngine(prisma);
  let dir: string | null = null;
  let dirProblem: string | null = null;
  try {
    dir = aiDir();
  } catch (err) {
    dirProblem = (err as Error).message;
  }
  const jobs = await prisma.aiVideoJob.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
    take: RECENT_VIDEOS,
    include: { clip: { select: { projectId: true, name: true } } },
  });

  return (
    <>
      <Card>
        <div className={styles.stack}>
          <div className={styles.heading}>
            <h2>AI video engine</h2>
            <StatusBadge status={engine.status} />
          </div>
          <p className={styles.note}>
            ComfyUI {AI_ENGINE.comfyui.version} (GPL-3.0) with the Wan 2.2 TI2V 5B video model (Apache-2.0), downloaded
            once into {dir ?? "the data folder"}.
          </p>
          {dirProblem ? <Alert tone="error">{dirProblem}</Alert> : null}
          {engine.status === "installing" ? <EngineProgress initialStep={engine.step} initialPercent={engine.percent} /> : null}
          {engine.status === "installed" && engine.installedBytes !== null ? (
            <div className={styles.row}>
              <span>Installed, {formatGigabytes(engine.installedBytes)} on disk.</span>
              <ActionForm
                action={uninstallAiEngineAction}
                confirm={{
                  message: `Delete the AI video engine (${formatGigabytes(engine.installedBytes)}) from this PC? The AI videos already made stay in your clips.`,
                  confirmLabel: "Uninstall",
                }}
              >
                <SubmitButton variant="danger" pendingLabel="Uninstalling…">
                  Uninstall
                </SubmitButton>
              </ActionForm>
            </div>
          ) : null}
          {engine.status === "failed" ? <Alert tone="error">The install stopped: {engine.error}</Alert> : null}
          {(engine.status === "not_installed" || engine.status === "failed") && dir ? (
            <div className={styles.row}>
              <span>
                Downloads {formatGigabytes(downloadBytes(AI_ENGINE))} and needs {formatGigabytes(requiredFreeBytes(AI_ENGINE))} of free disk space.
                {engine.status === "failed" ? " Files already downloaded are kept." : ""}
              </span>
              <ActionForm action={installAiEngineAction}>
                <SubmitButton variant="primary" pendingLabel="Starting…">
                  {engine.status === "failed" ? "Try again" : "Install"}
                </SubmitButton>
              </ActionForm>
            </div>
          ) : null}
        </div>
      </Card>

      {engine.status === "installed" ? (
        <Card>
          <div className={styles.stack}>
            <h2>New AI video</h2>
            <NewVideoForm maxPromptLength={MAX_PROMPT_LENGTH} />
          </div>
        </Card>
      ) : null}

      <section>
        <h2 className={styles.sectionTitle}>Recent AI videos</h2>
        {jobs.length === 0 ? (
          <EmptyState>No AI videos yet.</EmptyState>
        ) : (
          <ul className={styles.jobs}>
            {jobs.map((job) => (
              <li key={job.id}>
                <p className={styles.prompt}>{job.prompt}</p>
                <div className={styles.jobMeta}>
                  {job.status === "queued" || job.status === "running" ? (
                    <VideoProgress jobId={job.id} initialStatus={job.status} initialStep={job.step} />
                  ) : (
                    <StatusBadge status={job.status} label={job.status === "done" ? "Done" : undefined} />
                  )}
                  <span className={styles.meta}>
                    {job.seconds} s{job.startImageKey ? " · from a picture" : ""} · <LocalTime date={job.createdAt} />
                  </span>
                  {job.clip ? <Link href={`/clips/${job.clip.projectId}`}>Open {job.clip.name} in AI videos</Link> : null}
                </div>
                {job.status === "failed" ? <Alert tone="error">{job.error}</Alert> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
