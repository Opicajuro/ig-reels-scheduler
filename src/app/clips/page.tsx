import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { getOwnerId } from "@/lib/owner";
import { describeClipProject } from "@/lib/clip-status";
import { prisma } from "@/lib/prisma";
import { createLinkProjectAction } from "./actions";
import styles from "./clips.module.css";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Clips" };

export default async function ClipsPage() {
  await connection();
  const ownerId = await getOwnerId();

  const projects = await prisma.clipProject.findMany({
    where: { ownerId: ownerId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { clips: true } } },
  });

  return (
    <main className={styles.page}>
      <PageHeader title="Clips" description="Cut a long video into vertical clips." />
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

      <h2>Projects</h2>
      {projects.length === 0 ? (
        <EmptyState>No projects yet.</EmptyState>
      ) : (
        <ul className={styles.projects}>
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/clips/${project.id}`}>
                <strong>{project.name}</strong>
                <span className={styles.meta}>
                  {describeClipProject({ status: project.status, error: project.error, clipCount: project._count.clips })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
