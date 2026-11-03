import { existsSync } from "node:fs";
import path from "node:path";
import { requireEnv } from "./env";
import { findTrack } from "./music-library";

// Where a library track's file is on this PC: in MUSIC_DIR, which setup points at the installer's tools\music.
export function musicFile(trackId: string): string {
  const file = path.join(requireEnv("MUSIC_DIR"), findTrack(trackId).file);
  if (!existsSync(file)) throw new Error(`the music file ${file} is missing; run the installer again`);
  return file;
}
