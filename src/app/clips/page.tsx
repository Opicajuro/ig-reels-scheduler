import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { describeClipProject } from "@/lib/clip-status";
import { prisma } from "@/lib/prisma";
import { createLinkProjectAction } from "./actions";
import styles from "./clips.module.css";
import { UploadForm } from "./upload-form";

async function ClipProjects() {
  await connection();
  const ownerId = await getOwnerId();

  const projects = await prisma.clipProject.findMany({
    where: { ownerId: ownerId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { clips: true } } },
  });

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <div className={styles.grid2}>
          <UploadForm />
          <form className={styles.panel} action={createLinkProjectAction}>
            <h2>Or paste a video link</h2>
            <p className={styles.muted}>Works with links yt-dlp can download. Only use videos you have the rights to.</p>
            <input type="text" name="name" placeholder="Project name" maxLength={120} required />
            <input type="url" name="url" placeholder="https://…" required />
            <button type="submit" className={styles.primary}>
              Create project from link
            </button>
          </form>
        </div>

        <h2>Projects</h2>
        {projects.length === 0 ? (
          <p className={styles.muted}>No projects yet.</p>
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
      </div>
    </div>
  );
}

export default function ClipsPage() {
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <ClipProjects />
    </Suspense>
  );
}
