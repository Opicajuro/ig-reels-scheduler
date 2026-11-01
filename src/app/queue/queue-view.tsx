"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { StatusBadge } from "@/components/status-badge";
import type { QueueListing } from "@/lib/work-queue";
import { formatElapsed } from "../clips/render-progress";
import { CancelPostForm } from "../scheduled/post-actions";
import { cancelAiVideoAction, cancelRenderAction } from "./actions";
import styles from "./queue.module.css";

const POLL_MS = 2000;

// The queue as the page was rendered, then as the status route reports it every 2 seconds. Everything shown comes from
// that JSON, so a row that finished or was cancelled just drops out, without reloading the page.
export function QueueView({ initial }: { initial: QueueListing }) {
  const [listing, setListing] = useState(initial);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const timer = setInterval(async () => {
      const response = await fetch("/api/queue", { cache: "no-store" });
      if (!response.ok) throw new Error(`queue check failed with ${response.status}`);
      setListing((await response.json()) as QueueListing);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const { renders, aiVideos, posts } = listing;
  return (
    <div className={styles.queue}>
      <Section title="Clips being made" empty="No clips are being made.">
        {renders.map((render) => {
          const elapsed = formatElapsed(Math.max(0, Math.floor((now - Date.parse(render.startedAt)) / 1000)));
          return (
            <Row
              key={render.id}
              href={`/clips/${render.id}`}
              title={render.name}
              state={<StatusBadge status="rendering" />}
              detail={render.step ?? "Waiting for the worker to start…"}
              progress={
                <>
                  {render.clipsTotal === null ? null : (
                    <span>
                      {render.clipsDone} of {render.clipsTotal} clips
                    </span>
                  )}
                  <span className={styles.elapsed} aria-label={`running for ${elapsed}`}>
                    {elapsed}
                  </span>
                </>
              }
              cancel={
                <ActionForm
                  action={cancelRenderAction}
                  confirm={{
                    message: `Stop making clips for "${render.name}"? The clips already made are kept.`,
                    confirmLabel: "Stop making clips",
                  }}
                >
                  <input type="hidden" name="projectId" value={render.id} />
                  <SubmitButton variant="danger" size="sm" pendingLabel="Cancelling…">
                    Cancel
                  </SubmitButton>
                </ActionForm>
              }
            />
          );
        })}
      </Section>

      <Section title="AI videos" empty="No AI video is waiting or being made.">
        {aiVideos.map((video) => (
          <Row
            key={video.id}
            href="/clips"
            title={video.prompt}
            state={<StatusBadge status={video.status} />}
            detail={video.step ?? (video.status === "queued" ? "Waiting for the worker" : "")}
            cancel={
              <ActionForm
                action={cancelAiVideoAction}
                confirm={{ message: "Stop this AI video? It will not be made.", confirmLabel: "Stop video" }}
              >
                <input type="hidden" name="jobId" value={video.id} />
                <SubmitButton variant="danger" size="sm" pendingLabel="Cancelling…">
                  Cancel
                </SubmitButton>
              </ActionForm>
            }
          />
        ))}
      </Section>

      <Section title="Publishing within the hour" empty="Nothing publishes in the next hour.">
        {posts.map((post) => (
          <Row
            key={post.id}
            href={`/posts/${post.id}`}
            title={post.caption || "(no caption)"}
            state={<StatusBadge status={post.status} />}
            detail={
              <>
                @{post.username} · <LocalTime date={new Date(post.scheduledAt)} />
              </>
            }
            cancel={<CancelPostForm postId={post.id} />}
          />
        ))}
      </Section>
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section>
      <h2 className={styles.heading}>{title}</h2>
      {children.length === 0 ? <EmptyState>{empty}</EmptyState> : <ul className={styles.rows}>{children}</ul>}
    </section>
  );
}

function Row({
  href,
  title,
  state,
  detail,
  progress,
  cancel,
}: {
  href: string;
  title: string;
  state: ReactNode;
  detail: ReactNode;
  progress?: ReactNode;
  cancel: ReactNode;
}) {
  return (
    <li className={styles.row}>
      <Link href={href} className={styles.title}>
        {title}
      </Link>
      <div className={styles.status} role="status">
        {state}
        <span className={styles.detail}>{detail}</span>
        {progress}
      </div>
      <div className={styles.cancel}>{cancel}</div>
    </li>
  );
}
