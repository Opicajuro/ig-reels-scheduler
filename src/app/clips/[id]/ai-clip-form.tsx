"use client";

import { useRef, useState, type ReactNode } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/field";
import { AI_CLIP_LABELS, BROLL_SECONDS, INTRO_SECONDS, suggestAiPrompt, type AiClipKind } from "@/lib/ai-clip-options";
import { formatTime } from "@/lib/highlights";
import { createAiClipAction } from "../ai-actions";
import aiStyles from "../ai.module.css";
import styles from "../clips.module.css";

// What the AI panels need from the page: why this PC cannot make AI video (null when it can), and the prompt limit.
export type AiClipSetup = { unavailable: ReactNode | null; maxPromptLength: number };

type AiClip = { id: string; name: string; title: string | null; length: number; firstWords: string; downloadUrl: string };

const STEP = 0.1;

// "AI intro" or "AI B-roll" on one clip. A B-roll moment is picked with a slider that moves the preview to it.
export function AiClipForm({ clip, kind, setup }: { clip: AiClip; kind: AiClipKind; setup: AiClipSetup }) {
  const preview = useRef<HTMLVideoElement>(null);
  const latest = Math.max(0, Math.floor((clip.length - BROLL_SECONDS) * 10) / 10);
  const [at, setAt] = useState(0);

  if (setup.unavailable) return <div className={styles.panel}>{setup.unavailable}</div>;
  if (kind === "broll" && clip.length < BROLL_SECONDS) {
    return <p className={styles.muted}>This clip is shorter than the {BROLL_SECONDS} s B-roll shot.</p>;
  }

  return (
    <ActionForm action={createAiClipAction} className={aiStyles.form}>
      <input type="hidden" name="clipId" value={clip.id} />
      <input type="hidden" name="kind" value={kind} />
      <p className={styles.muted}>
        {kind === "intro"
          ? "The clip's first frame is the start picture. The AI shot plays before the clip, as a new clip; this one stays as it is."
          : `A ${BROLL_SECONDS} s AI shot, started from the frame at the moment you pick, covers the picture while the sound keeps playing. It is saved as a new clip; this one stays as it is.`}
      </p>
      {kind === "broll" ? (
        <>
          <video ref={preview} className={styles.player} src={`${clip.downloadUrl}#t=0`} muted playsInline preload="metadata" />
          <Field label={`Moment: ${formatTime(at)} – ${formatTime(at + BROLL_SECONDS)}`} hint="Where the AI shot covers the picture.">
            <input
              type="range"
              name="at"
              min={0}
              max={latest}
              step={STEP}
              value={at}
              onChange={(event) => {
                const value = Number(event.target.value);
                setAt(value);
                preview.current!.currentTime = value;
              }}
            />
          </Field>
          <input type="hidden" name="seconds" value={BROLL_SECONDS} />
        </>
      ) : (
        <div>
          <span className={aiStyles.label}>Length</span>
          <div className={aiStyles.choice}>
            {INTRO_SECONDS.map((seconds) => (
              <label key={seconds}>
                <input type="radio" name="seconds" value={seconds} defaultChecked={seconds === INTRO_SECONDS[0]} />
                <span>{seconds} s</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <Field label="Describe the shot" hint="What is in it, how it moves, and how the camera moves. English works best.">
        <textarea
          name="prompt"
          rows={4}
          maxLength={setup.maxPromptLength}
          required
          defaultValue={suggestAiPrompt(kind, { title: clip.title, words: clip.firstWords })}
        />
      </Field>
      <p className={aiStyles.madeWithAi}>
        Made with AI: the new clip is marked as AI-made in Localirs, and Instagram should be told when it is posted.
      </p>
      <SubmitButton variant="primary" pendingLabel="Starting…">
        Make {AI_CLIP_LABELS[kind]}
      </SubmitButton>
    </ActionForm>
  );
}
