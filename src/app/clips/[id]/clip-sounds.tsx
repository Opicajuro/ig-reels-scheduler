"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Button } from "@/components/button";
import { SoundSelect } from "@/components/sound-effects";
import { AUTO_SOUNDS, DEFAULT_SOUND_VOLUME, MAX_CLIP_SOUNDS, type ClipSound } from "@/lib/clip-sounds";
import { BASE_CUT_REMOVED } from "@/lib/storage-messages";
import { resoundClipAction } from "../sound-actions";
import styles from "../clips.module.css";
import own from "./clip-sounds.module.css";
import { RecaptionProgress } from "./clip-captions";
import type { ClipView } from "./clip-grid";

// The Sounds tab of a clip's drawer: the clip's own sound effects, each at a time and volume. A sound is added at the
// player's current time; saving mixes them again over the clip's kept cut, with its captions and automatic sounds.
export function ClipSounds({
  clip,
  projectId,
  busy,
  currentTime,
}: {
  clip: ClipView;
  projectId: string;
  busy: boolean;
  // Where the drawer's player is, in seconds.
  currentTime: () => number;
}) {
  if (!clip.baseCut) return <p className={styles.muted}>{clip.words !== null ? BASE_CUT_REMOVED : "Sounds can be added to clips made after this update."}</p>;
  return <SoundEditor clip={clip} projectId={projectId} busy={busy} currentTime={currentTime} />;
}

function SoundEditor({
  clip,
  projectId,
  busy,
  currentTime,
}: {
  clip: ClipView;
  projectId: string;
  busy: boolean;
  currentTime: () => number;
}) {
  const [sounds, setSounds] = useState<ClipSound[]>(clip.sounds);
  const [next, setNext] = useState(AUTO_SOUNDS.hook.sound);
  const locked = clip.recaption !== null;
  const changed = JSON.stringify(sounds) !== JSON.stringify(clip.sounds);

  function add() {
    const time = Math.min(Math.round(currentTime() * 100) / 100, Math.floor((clip.length - 0.01) * 100) / 100);
    setSounds([...sounds, { time, sound: next, volume: DEFAULT_SOUND_VOLUME }].sort((a, b) => a.time - b.time));
  }

  function change(index: number, sound: Partial<ClipSound>) {
    setSounds(sounds.map((item, at) => (at === index ? { ...item, ...sound } : item)));
  }

  return (
    <div className={styles.panel}>
      <p className={styles.muted}>
        Play the clip to where a sound should go, pick it and add it. The project&apos;s automatic sounds are added as well.
        Making clips again replaces this clip, and these sounds are lost.
      </p>
      {clip.recaption ? <RecaptionProgress clipId={clip.id} projectId={projectId} initialStep={clip.recaption.step} /> : null}
      {clip.recaptionError ? <Alert tone="error">The last re-render failed: {clip.recaptionError}</Alert> : null}
      <div className={own.add}>
        <SoundSelect value={next} label="Sound to add" onChange={setNext} disabled={locked} />
        <Button type="button" variant="primary" size="sm" disabled={locked || sounds.length >= MAX_CLIP_SOUNDS} onClick={add}>
          Add at the current time
        </Button>
      </div>
      {sounds.length === 0 ? (
        <p className={styles.muted}>This clip has no sounds of its own.</p>
      ) : (
        <ol className={own.list}>
          {sounds.map((sound, index) => (
            <li key={index} className={own.item}>
              <label className={own.time}>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, clip.length - 0.01).toFixed(2)}
                  step={0.01}
                  value={sound.time}
                  disabled={locked}
                  aria-label={`Sound ${index + 1} time, in seconds`}
                  onChange={(event) => change(index, { time: Number(event.target.value) })}
                />
                <span>s</span>
              </label>
              <SoundSelect value={sound.sound} label={`Sound ${index + 1}`} onChange={(id) => change(index, { sound: id })} disabled={locked} />
              <label className={own.volume}>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={sound.volume}
                  disabled={locked}
                  aria-label={`Sound ${index + 1} volume`}
                  onChange={(event) => change(index, { volume: Number(event.target.value) })}
                />
                <span>{sound.volume}%</span>
              </label>
              <button
                type="button"
                disabled={locked}
                aria-label={`Delete sound ${index + 1}`}
                title="Delete this sound"
                onClick={() => setSounds(sounds.filter((_, at) => at !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className={styles.clipTools}>
        <ActionForm action={resoundClipAction}>
          <input type="hidden" name="clipId" value={clip.id} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="sounds" value={JSON.stringify(sounds)} />
          <SubmitButton variant="primary" disabled={busy || locked} pendingLabel="Queuing…">
            Save and re-render
          </SubmitButton>
        </ActionForm>
        <Button type="button" disabled={!changed || locked} onClick={() => setSounds(clip.sounds)}>
          Undo edits
        </Button>
      </div>
    </div>
  );
}
