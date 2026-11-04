"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Button } from "@/components/button";
import {
  clipLines,
  deleteWord,
  mergeWithNextLine,
  setWordText,
  splitAtWord,
  WORD_MAX,
  type ClipWord,
} from "@/lib/caption-words";
import { BASE_CUT_REMOVED } from "@/lib/storage-messages";
import { cancelRecaptionAction } from "../../queue/actions";
import { recaptionClipAction } from "../actions";
import styles from "../clips.module.css";
import type { ClipView } from "./clip-grid";

const POLL_MS = 2000;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// The Captions tab of a clip's drawer: the clip's words in the lines its captions show, to fix, split or merge, or
// delete, then draw again over the clip's kept cut. The times stay as they were spoken.
export function ClipCaptions({ clip, projectId, busy }: { clip: ClipView; projectId: string; busy: boolean }) {
  if (clip.baseCutRemoved) return <p className={styles.muted}>{BASE_CUT_REMOVED}</p>;
  if (clip.words === null) {
    return <p className={styles.muted}>Captions can be edited on clips made after this update, with captions on.</p>;
  }
  return <CaptionEditor clip={clip} initial={clip.words} projectId={projectId} busy={busy} />;
}

function CaptionEditor({
  clip,
  initial,
  projectId,
  busy,
}: {
  clip: ClipView;
  initial: ClipWord[];
  projectId: string;
  busy: boolean;
}) {
  const [words, setWords] = useState(initial);
  const locked = clip.recaption !== null;
  const lines = clipLines(words);
  const changed = JSON.stringify(words) !== JSON.stringify(initial);

  return (
    <div className={styles.panel}>
      <p className={styles.muted}>
        Fix a word, start a new line at a word, merge a line with the next, or delete a filler. The timings stay. Making
        clips again replaces this clip, and these edits are lost.
      </p>
      {clip.recaption ? <RecaptionProgress clipId={clip.id} projectId={projectId} initialStep={clip.recaption.step} /> : null}
      {clip.recaptionError ? <Alert tone="error">The last re-render failed: {clip.recaptionError}</Alert> : null}
      {lines.length === 0 ? (
        <p className={styles.muted}>This clip has no caption words.</p>
      ) : (
        <ol className={styles.captionLines}>
          {lines.map((line, lineIndex) => (
            <li key={`${line.startMs}-${line.first}`} className={styles.captionLine}>
              <span className={styles.meta}>
                {seconds(line.startMs)} – {seconds(line.endMs)}
              </span>
              <div className={styles.captionWords}>
                {line.words.map((word, wordIndex) => {
                  const index = line.first + wordIndex;
                  return (
                    <span key={`${word.startMs}-${word.endMs}`} className={styles.captionWord}>
                      <input
                        type="text"
                        value={word.text}
                        size={Math.max(2, word.text.length)}
                        maxLength={WORD_MAX}
                        disabled={locked}
                        aria-label={`Word at ${seconds(word.startMs)}`}
                        title={`${seconds(word.startMs)} – ${seconds(word.endMs)}`}
                        onChange={(event) => setWords(setWordText(words, index, event.target.value))}
                      />
                      {wordIndex > 0 ? (
                        <button
                          type="button"
                          disabled={locked}
                          aria-label={`Start a new line at "${word.text}"`}
                          title="Start a new line here"
                          onClick={() => setWords(splitAtWord(words, index))}
                        >
                          ↵
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={locked}
                        aria-label={`Delete "${word.text}"`}
                        title="Delete this word"
                        onClick={() => setWords(deleteWord(words, index))}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
              {lineIndex < lines.length - 1 ? (
                <Button type="button" size="sm" disabled={locked} onClick={() => setWords(mergeWithNextLine(words, lineIndex))}>
                  Merge with next line
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <div className={styles.clipTools}>
        <ActionForm action={recaptionClipAction}>
          <input type="hidden" name="clipId" value={clip.id} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="words" value={JSON.stringify(words)} />
          <SubmitButton variant="primary" disabled={busy || locked} pendingLabel="Queuing…">
            Save and re-render
          </SubmitButton>
        </ActionForm>
        <Button type="button" disabled={!changed || locked} onClick={() => setWords(initial)}>
          Undo edits
        </Button>
      </div>
    </div>
  );
}

// While the clip's captions are drawn again: the worker's step, polled from the project's status, and a Cancel. The
// page is reloaded once the clip is replaced, so the drawer plays the new version.
function RecaptionProgress({ clipId, projectId, initialStep }: { clipId: string; projectId: string; initialStep: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState(initialStep);

  useEffect(() => {
    const timer = setInterval(async () => {
      const response = await fetch(`/api/clips/${projectId}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status check failed with ${response.status}`);
      const state = (await response.json()) as { recaptions: { id: string; step: string | null }[] };
      const mine = state.recaptions.find((recaption) => recaption.id === clipId);
      if (!mine) {
        clearInterval(timer);
        router.refresh();
        return;
      }
      setStep(mine.step);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [clipId, projectId, router]);

  return (
    <div className={styles.progress} role="status">
      <span>Re-rendering: {step ?? "waiting for the worker…"}</span>
      <ActionForm
        action={cancelRecaptionAction}
        confirm={{ message: "Stop re-rendering the captions? The clip stays as it is.", confirmLabel: "Stop re-rendering" }}
      >
        <input type="hidden" name="clipId" value={clipId} />
        <input type="hidden" name="projectId" value={projectId} />
        <SubmitButton variant="danger" size="sm" pendingLabel="Cancelling…">
          Cancel
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
