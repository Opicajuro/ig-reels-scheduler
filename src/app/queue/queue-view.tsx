"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { StatusBadge } from "@/components/status-badge";
import { AI_CLIP_LABELS } from "@/lib/ai-clip-options";
import type { QueueListing } from "@/lib/work-queue";
import { formatElapsed } from "../clips/render-progress";
import { CancelPostForm } from "../scheduled/post-actions";
import { cancelAiVideoAction, cancelRecaptionAction, cancelRenderAction, cancelSlideshowAction } from "./actions";
import styles from "./queue.module.css";

const POLL_MS = 2000;

// Every row's key, to tell when one has finished or was cancelled.
function rowKeys(listing: QueueListing): string[] {
  return [
    ...listing.renders.map((row) => `render:${row.id}`),
    ...listing.recaptions.map((row) => `recaption:${row.id}`),
    ...listing.aiVideos.map((row) => `video:${row.id}`),
    ...listing.slideshows.map((row) => `slideshow:${row.id}`),
    ...listing.engines.map((row) => `engine:${row.id}`),
    ...listing.posts.map((row) => `post:${row.id}`),
  ];
}

// The queue as the page was rendered, then as the status route reports it every 2 seconds. When a row drops out, the
// page is refreshed once, so the rest of the app shows what it finished.
export function QueueView({ initial }: { initial: QueueListing }) {
  const router = useRouter();
  const [listing, setListing] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const shown = useRef(rowKeys(initial));

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    const timer = setInterval(async () => {
      const response = await fetch("/api/queue", { cache: "no-store" });
      if (!response.ok) throw new Error(`queue check failed with ${response.status}`);
      const next = (await response.json()) as QueueListing;
      const keys = rowKeys(next);
      const finished = shown.current.some((key) => !keys.includes(key));
      shown.current = keys;
      setListing(next);
      if (finished) router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [router]);

  const { renders, recaptions, aiVideos, slideshows, engines, posts } = listing;
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
              state={<StatusBadge status={render.status} />}
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
                    message:
                      render.status === "picking"
                        ? `Stop finding highlights for "${render.name}"?`
                        : `Stop making clips for "${render.name}"? The clips already made are kept.`,
                    confirmLabel: render.status === "picking" ? "Stop finding highlights" : "Stop making clips",
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

      <Section title="Captions being re-rendered" empty="No clip's captions are being re-rendered.">
        {recaptions.map((clip) => (
          <Row
            key={clip.id}
            href={`/clips/${clip.projectId}`}
            title={`${clip.name} · ${clip.projectName}`}
            state={<StatusBadge status="rendering" label="Re-rendering" />}
            detail={clip.step ?? "Waiting for the worker"}
            cancel={
              <ActionForm
                action={cancelRecaptionAction}
                confirm={{
                  message: `Stop re-rendering the captions of ${clip.name}? The clip stays as it is.`,
                  confirmLabel: "Stop re-rendering",
                }}
              >
                <input type="hidden" name="clipId" value={clip.id} />
                <input type="hidden" name="projectId" value={clip.projectId} />
                <SubmitButton variant="danger" size="sm" pendingLabel="Cancelling…">
                  Cancel
                </SubmitButton>
              </ActionForm>
            }
          />
        ))}
      </Section>

      <Section title="AI videos" empty="No AI video is waiting or being made.">
        {aiVideos.map((video) => (
          <Row
            key={video.id}
            href={video.projectId ? `/clips/${video.projectId}` : "/clips?tab=ai"}
            title={video.kind === "prompt" ? video.prompt : `${AI_CLIP_LABELS[video.kind]}: ${video.prompt}`}
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

      <Section title="Slideshows" empty="No slideshow is being written or made.">
        {slideshows.map((show) => (
          <Row
            key={show.id}
            href="/clips?tab=slideshow"
            title={show.topic}
            state={<StatusBadge status={show.status} label={show.status === "running" ? "Making slideshow" : undefined} />}
            detail={show.step ?? (show.status === "queued" ? "Waiting for the worker" : "")}
            cancel={
              <ActionForm
                action={cancelSlideshowAction}
                confirm={{
                  message:
                    show.status === "writing"
                      ? "Stop writing this script? The slideshow is not made."
                      : "Stop making this slideshow? Its draft is kept, so you can make it again.",
                  confirmLabel: "Stop slideshow",
                }}
              >
                <input type="hidden" name="jobId" value={show.id} />
                <SubmitButton variant="danger" size="sm" pendingLabel="Cancelling…">
                  Cancel
                </SubmitButton>
              </ActionForm>
            }
          />
        ))}
      </Section>

      <Section title="Engine installs" empty="No engine is being installed.">
        {engines.map((engine) => (
          <Row
            key={engine.id}
            href={engine.id === "ai" ? "/settings#ai-video" : "/settings#slideshow-ai"}
            title={engine.name}
            state={<StatusBadge status="installing" />}
            detail={engine.step ?? ""}
            progress={
              engine.percent === null ? null : (
                <progress className={styles.progress} max={100} value={engine.percent} aria-label={`${engine.name} install progress`} />
              )
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
  // Engine installs cannot be cancelled: they keep what they downloaded, and are removed in Settings.
  cancel?: ReactNode;
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
      {cancel ? <div className={styles.cancel}>{cancel}</div> : null}
    </li>
  );
}
