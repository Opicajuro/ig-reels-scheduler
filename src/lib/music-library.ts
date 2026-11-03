import library from "@/clip-engine/music-library.json";
import { UserError } from "./user-error";

// The built-in music and sound effects. Every file is pinned by URL and SHA-256 in music-library.json, which also
// records where it comes from, its licence and when that was checked; the installer puts the files in tools\music and
// setup writes that folder to .env as MUSIC_DIR. Only CC0 tracks and Kevin MacLeod's CC BY 4.0 tracks are allowed; a
// CC BY track carries the credit line that goes in the caption of every post of a clip that uses it.

export type MusicTrack = (typeof library.tracks)[number] & { credit?: string };

export const TRACKS: MusicTrack[] = library.tracks;
export const MUSIC_TRACKS = TRACKS.filter((track) => track.kind === "music");
export const DEFAULT_MUSIC_VOLUME = 15;

export function findTrack(id: string): MusicTrack {
  const track = TRACKS.find((item) => item.id === id);
  if (!track) throw new Error(`unknown music track "${id}"`);
  return track;
}

// The background music a form asked for: a music track id or "" for none, and a volume of 0-100.
export function parseMusicChoice(track: string, volume: string): { musicTrack: string | null; musicVolume: number } {
  const percent = volume.trim() === "" ? NaN : Number(volume);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new UserError("the music volume must be a whole number from 0 to 100");
  if (track === "") return { musicTrack: null, musicVolume: percent };
  if (!MUSIC_TRACKS.some((item) => item.id === track)) throw new UserError(`unknown music track "${track}"`);
  return { musicTrack: track, musicVolume: percent };
}

// The credit line a clip's caption must carry, or null when its track (if any) needs none.
export function creditLine(musicTrack: string | null): string | null {
  if (!musicTrack) return null;
  return findTrack(musicTrack).credit ?? null;
}

// The caption with the track's credit line added at the end, unless it is already there.
export function withCredit(caption: string, musicTrack: string | null): string {
  const credit = creditLine(musicTrack);
  if (!credit || caption.includes(credit)) return caption;
  return caption ? `${caption}\n\n${credit}` : credit;
}

// Whether the caption still carries the credit line its track needs.
export function hasCredit(caption: string, musicTrack: string | null): boolean {
  const credit = creditLine(musicTrack);
  return !credit || caption.includes(credit);
}
