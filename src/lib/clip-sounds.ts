import { TRACKS } from "./music-library";
import { UserError } from "./user-error";

// Sound effects in clips, from the library's sound effects. A clip project can add some by itself: a whoosh as the
// hook title shows, a soft pop at each caption line and a tick at each jump cut of a tightened clip. A clip's own
// sounds (Clip.sounds) are added in its Sounds tab. Both are mixed over the clip's sound and music by finishClip.

export type ClipSound = { time: number; sound: string; volume: number };
export type AutoSoundKind = "hook" | "captions" | "cuts";

export const SOUND_EFFECTS = TRACKS.filter((track) => track.kind === "sfx");
export const DEFAULT_SOUND_VOLUME = 60;
export const MAX_CLIP_SOUNDS = 50;

// The automatic sounds: what each is called, the sound it starts with and how loud it plays.
export const AUTO_SOUNDS: Record<AutoSoundKind, { label: string; hint: string; sound: string; volume: number }> = {
  hook: {
    label: "Whoosh on the hook title",
    hint: "As the hook title shows, at the start.",
    sound: "kenney-weapon-change",
    volume: 80,
  },
  captions: {
    label: "Pop on each caption line",
    hint: "Quietly, as each caption line shows.",
    sound: "kenney-placement",
    volume: 25,
  },
  cuts: {
    label: "Sound on cuts",
    hint: "A soft tick at each jump cut Tighten pacing makes.",
    sound: "kenney-tile-swap",
    volume: 30,
  },
};

export function isSoundEffect(id: string): boolean {
  return SOUND_EFFECTS.some((track) => track.id === id);
}

// An automatic sound a form asked for: a sound effect id, or null for off.
export function parseAutoSound(sound: string | null): string | null {
  if (sound === null) return null;
  if (!isSoundEffect(sound)) throw new UserError(`unknown sound effect "${sound}"`);
  return sound;
}

// A clip's own sounds, from its Sounds tab or as stored, sorted by time. Each starts inside the clip.
export function parseClipSounds(value: unknown, length: number): ClipSound[] {
  if (!Array.isArray(value)) throw new UserError("the sounds are not a list");
  if (value.length > MAX_CLIP_SOUNDS) throw new UserError(`a clip can have at most ${MAX_CLIP_SOUNDS} sounds`);
  return value
    .map((item: unknown, index) => {
      const { time, sound, volume } = (item ?? {}) as Record<string, unknown>;
      if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time >= length) {
        throw new UserError(`sound ${index + 1} must start inside the clip's ${length.toFixed(1)} seconds`);
      }
      if (typeof sound !== "string" || !isSoundEffect(sound)) throw new UserError(`sound ${index + 1} is not a known sound effect`);
      if (typeof volume !== "number" || !Number.isInteger(volume) || volume < 0 || volume > 100) {
        throw new UserError(`sound ${index + 1}'s volume must be a whole number from 0 to 100`);
      }
      return { time: Math.round(time * 100) / 100, sound, volume };
    })
    .sort((a, b) => a.time - b.time);
}

// The sounds a clip gets from its project's automatic sounds: hook says whether it shows a hook title, lineStarts are
// its caption lines' starts and cuts its jump cuts, both in seconds of the clip's own time.
export function automaticSounds({
  project,
  hook,
  lineStarts,
  cuts,
}: {
  project: { sfxHook: string | null; sfxCaptions: string | null; sfxCuts: string | null };
  hook: boolean;
  lineStarts: number[];
  cuts: number[];
}): ClipSound[] {
  const sounds: ClipSound[] = [];
  if (project.sfxHook && hook) sounds.push({ time: 0, sound: project.sfxHook, volume: AUTO_SOUNDS.hook.volume });
  if (project.sfxCaptions) {
    for (const time of lineStarts) sounds.push({ time, sound: project.sfxCaptions, volume: AUTO_SOUNDS.captions.volume });
  }
  if (project.sfxCuts) for (const time of cuts) sounds.push({ time, sound: project.sfxCuts, volume: AUTO_SOUNDS.cuts.volume });
  return sounds;
}
