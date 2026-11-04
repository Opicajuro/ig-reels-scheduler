"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Button } from "@/components/button";
import type { ClipSuggestion } from "@/lib/clip-writer";
import { cancelClipWritingAction } from "../../queue/actions";
import { applySuggestionsAction, discardSuggestionAction, writeWithAiAction } from "../writer-actions";
import styles from "../clips.module.css";
import type { ClipView } from "./clip-grid";

const POLL_MS = 2000;

// While any of the clips is being written: each one's step, polled from the project's status. The page is reloaded once
// one of them is done, so its suggestion shows.
function useWriterSteps(projectId: string, writing: ClipView[]): Map<string, string | null> {
  const router = useRouter();
  const [steps, setSteps] = useState(() => new Map(writing.map((clip) => [clip.id, clip.writer!.step])));
  const ids = writing.map((clip) => clip.id).join(",");

  useEffect(() => {
    if (!ids) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/clips/${projectId}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status check failed with ${response.status}`);
      const state = (await response.json()) as { writers: { id: string; step: string | null }[] };
      const now = new Map(state.writers.map((writer) => [writer.id, writer.step]));
      setSteps(now);
      if (ids.split(",").some((id) => !now.has(id))) {
        clearInterval(timer);
        router.refresh();
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [ids, projectId, router]);

  return steps;
}

function NotInstalled() {
  return (
    <p className={styles.muted}>
      Titles are written offline by the slideshows&apos; script writer. <Link href="/settings#slideshow-ai">Install the Script writer</Link>{" "}
      in Settings → Slideshow AI.
    </p>
  );
}

function SuggestionText({ suggestion }: { suggestion: ClipSuggestion }) {
  return (
    <div className={styles.suggestion}>
      <strong>{suggestion.title}</strong>
      <p>{suggestion.description}</p>
      <p className={styles.meta}>{suggestion.hashtags.map((tag) => `#${tag}`).join(" ")}</p>
    </div>
  );
}

// The Details tab's "Write with AI": queues the clip, shows its step with a Cancel while it is written, then the
// suggestion, which changes nothing until "Use" fills in the title and the description with its hashtags.
export function WriteWithAi({ clip, projectId, installed, busy }: { clip: ClipView; projectId: string; installed: boolean; busy: boolean }) {
  const steps = useWriterSteps(projectId, clip.writer ? [clip] : []);

  return (
    <div className={styles.panel}>
      {clip.writer ? (
        <div className={styles.progress} role="status">
          <span>Writing with AI: {steps.get(clip.id) ?? "waiting for the worker…"}</span>
          <ActionForm action={cancelClipWritingAction}>
            <input type="hidden" name="clipId" value={clip.id} />
            <input type="hidden" name="projectId" value={projectId} />
            <SubmitButton variant="danger" size="sm" pendingLabel="Cancelling…">
              Cancel
            </SubmitButton>
          </ActionForm>
        </div>
      ) : installed ? (
        <ActionForm action={writeWithAiAction}>
          <input type="hidden" name="clipId" value={clip.id} />
          <input type="hidden" name="projectId" value={projectId} />
          <SubmitButton disabled={busy} pendingLabel="Queuing…">
            Write with AI
          </SubmitButton>
        </ActionForm>
      ) : (
        <>
          <Button type="button" disabled>
            Write with AI
          </Button>
          <NotInstalled />
        </>
      )}
      {clip.writeError ? <Alert tone="error">Writing with AI failed: {clip.writeError}</Alert> : null}
      {clip.suggestion ? (
        <>
          <SuggestionText suggestion={clip.suggestion} />
          <div className={styles.clipTools}>
            <ActionForm action={applySuggestionsAction}>
              <input type="hidden" name="clipId" value={clip.id} />
              <input type="hidden" name="projectId" value={projectId} />
              <SubmitButton variant="primary" pendingLabel="Filling in…">
                Use
              </SubmitButton>
            </ActionForm>
            <ActionForm action={discardSuggestionAction}>
              <input type="hidden" name="clipId" value={clip.id} />
              <input type="hidden" name="projectId" value={projectId} />
              <SubmitButton pendingLabel="Discarding…">Discard</SubmitButton>
            </ActionForm>
          </div>
          <p className={styles.muted}>Use replaces the title and the description below.</p>
        </>
      ) : null}
    </div>
  );
}

// The selection bar's "Write titles with AI": one job writes the picked clips one after another. Each clip's step,
// error or suggestion is listed, and "Use all" fills in every suggestion.
export function BulkWriter({ clips, projectId, installed, busy }: { clips: ClipView[]; projectId: string; installed: boolean; busy: boolean }) {
  const writing = clips.filter((clip) => clip.writer);
  const steps = useWriterSteps(projectId, writing);
  const suggested = clips.filter((clip) => clip.suggestion);

  return (
    <div className={styles.panel}>
      <p className={styles.muted}>
        The script writer reads what is said in each clip and suggests a title, a short description and hashtags. Nothing
        changes until you use them.
      </p>
      {installed ? (
        <ActionForm action={writeWithAiAction}>
          <input type="hidden" name="projectId" value={projectId} />
          {clips.map((clip) => (
            <input key={clip.id} type="hidden" name="clipId" value={clip.id} />
          ))}
          <SubmitButton variant="primary" disabled={busy || writing.length > 0} pendingLabel="Queuing…">
            Write titles with AI
          </SubmitButton>
        </ActionForm>
      ) : (
        <NotInstalled />
      )}
      <ul className={styles.suggestions}>
        {clips.map((clip) => (
          <li key={clip.id}>
            <span className={styles.meta}>{clip.name}</span>
            {clip.writer ? (
              <span className={styles.muted}>Writing with AI: {steps.get(clip.id) ?? "waiting for the worker…"}</span>
            ) : clip.suggestion ? (
              <SuggestionText suggestion={clip.suggestion} />
            ) : clip.writeError ? (
              <Alert tone="error">Writing with AI failed: {clip.writeError}</Alert>
            ) : (
              <span className={styles.muted}>No suggestion yet.</span>
            )}
          </li>
        ))}
      </ul>
      {suggested.length > 0 ? (
        <ActionForm action={applySuggestionsAction}>
          <input type="hidden" name="projectId" value={projectId} />
          {suggested.map((clip) => (
            <input key={clip.id} type="hidden" name="clipId" value={clip.id} />
          ))}
          <SubmitButton pendingLabel="Filling in…">
            Use all ({suggested.length})
          </SubmitButton>
        </ActionForm>
      ) : null}
    </div>
  );
}
