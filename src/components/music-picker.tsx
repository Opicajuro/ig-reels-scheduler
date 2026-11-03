"use client";

import { useState } from "react";
import { Field } from "./field";
import { DEFAULT_MUSIC_VOLUME, MUSIC_TRACKS, type MusicTrack } from "@/lib/music-library";
import styles from "./music-picker.module.css";

const COLLECTIONS: Array<{ id: string; label: string }> = [
  { id: "opengameart", label: "OpenGameArt (CC0)" },
  { id: "kevin-macleod", label: "Kevin MacLeod (CC BY 4.0, credit added to the caption)" },
];

function minutes(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// "Background music": a track from the built-in library, with a player to hear it first, and its volume. Sends
// musicTrack ("" for none) and musicVolume (0-100).
export function MusicPicker({ track, volume }: { track: string | null; volume?: number }) {
  const [picked, setPicked] = useState(track ?? "");
  const [level, setLevel] = useState(volume ?? DEFAULT_MUSIC_VOLUME);
  const chosen: MusicTrack | undefined = MUSIC_TRACKS.find((item) => item.id === picked);

  return (
    <div className={styles.picker}>
      <Field
        label="Background music"
        hint="Looped or cut to the video's length, faded in and out, and turned down while someone speaks. Instagram can still mute a track if someone claims it."
      >
        <select name="musicTrack" value={picked} onChange={(event) => setPicked(event.target.value)}>
          <option value="">None</option>
          {COLLECTIONS.map((collection) => (
            <optgroup key={collection.id} label={collection.label}>
              {MUSIC_TRACKS.filter((item) => item.collection === collection.id).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.author} · {minutes(item.seconds)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {chosen ? (
        <>
          <audio key={chosen.id} className={styles.player} controls preload="none" src={`/api/music/${chosen.id}`} />
          <p className={styles.about}>
            {chosen.licence === "CC0-1.0" ? "CC0, no credit needed" : `${chosen.licence}: the credit line is added to the caption`}
            {" · "}
            <a href={chosen.sourceUrl} target="_blank" rel="noreferrer">
              Source
            </a>
            {` · licence checked ${chosen.checked}`}
          </p>
        </>
      ) : null}
      <label className={styles.volume}>
        <span>Music volume</span>
        <input
          type="range"
          name="musicVolume"
          min={0}
          max={100}
          step={1}
          value={level}
          onChange={(event) => setLevel(Number(event.target.value))}
          disabled={!chosen}
        />
        <span>{level}%</span>
      </label>
      {!chosen ? <input type="hidden" name="musicVolume" value={level} /> : null}
    </div>
  );
}
