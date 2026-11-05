"use client";

import { useState } from "react";
import { Button } from "./button";
import { AUTO_SOUNDS, SOUND_EFFECTS, type AutoSoundKind } from "@/lib/clip-sounds";
import styles from "./sound-effects.module.css";

// Plays a library sound effect once, for choosing one.
export function playSound(id: string) {
  void new Audio(`/api/music/${id}`).play();
}

// A sound effect from the library, with a button to hear it.
export function SoundSelect({
  name,
  value,
  label,
  onChange,
  disabled,
}: {
  name?: string;
  value: string;
  label: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <select name={name} value={value} aria-label={label} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {SOUND_EFFECTS.map((sound) => (
          <option key={sound.id} value={sound.id}>
            {sound.title} · {sound.seconds.toFixed(1)} s
          </option>
        ))}
      </select>
      <Button type="button" size="sm" aria-label={`Play ${label.toLowerCase()}`} onClick={() => playSound(value)}>
        ▶ Play
      </Button>
    </>
  );
}

const KINDS: { kind: AutoSoundKind; name: string }[] = [
  { kind: "hook", name: "sfxHook" },
  { kind: "captions", name: "sfxCaptions" },
  { kind: "cuts", name: "sfxCuts" },
];

function AutoSound({ kind, name, initial }: { kind: AutoSoundKind; name: string; initial: string | null }) {
  const [sound, setSound] = useState(initial ?? AUTO_SOUNDS[kind].sound);
  const { label, hint } = AUTO_SOUNDS[kind];
  return (
    <div className={styles.auto}>
      <label className={styles.toggle} title={hint}>
        <span>{label}</span>
        <input type="checkbox" name={name} defaultChecked={initial !== null} />
      </label>
      <div className={styles.row}>
        <SoundSelect name={`${name}Sound`} value={sound} label={label} onChange={setSound} />
      </div>
    </div>
  );
}

// "Sound effects" in a clip project's settings: the sounds its clips get by themselves, each off by default, with the
// sound to use. Sends sfxHook, sfxCaptions and sfxCuts ("on" when on), each with its sound as <name>Sound.
export function AutoSoundsPicker({ sfxHook, sfxCaptions, sfxCuts }: { sfxHook: string | null; sfxCaptions: string | null; sfxCuts: string | null }) {
  const initial: Record<AutoSoundKind, string | null> = { hook: sfxHook, captions: sfxCaptions, cuts: sfxCuts };
  return (
    <div className={styles.sounds}>
      {KINDS.map(({ kind, name }) => (
        <AutoSound key={kind} kind={kind} name={name} initial={initial[kind]} />
      ))}
      <span className={styles.hint}>Each clip can also get its own sounds, in its Sounds tab.</span>
    </div>
  );
}
