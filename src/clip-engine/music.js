import { spawn } from "node:child_process";

// Background music under a finished clip or slideshow. The track is looped or cut to the clip's length, faded in and
// out over FADE_SECONDS, set to the chosen volume and ducked under the clip's own sound with ffmpeg's
// sidechaincompress, keyed by that sound: whenever someone speaks the music drops, and it comes back within
// RELEASE_MS once they stop. Keying on the audio itself, rather than on whisper's word times, ducks every clip the same
// way, captioned or not, and also ducks under laughs and other sounds whisper does not write down.

export const FADE_SECONDS = 0.5;
// The key level above which the music is turned down (about -36 dBFS), how hard, and how fast it goes down and back.
// Quiet speech, around -20 dBFS, takes the music down by about 15 dB.
const DUCK_THRESHOLD = 0.015;
const DUCK_RATIO = 20;
const ATTACK_MS = 20;
const RELEASE_MS = 300;

export function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().split("\n").slice(-5).join("\n")}`));
    });
  });
}

// The filter graph that mixes input 1 (the music, looped with -stream_loop) under input 0's sound into [aout]: length
// is the clip's length in seconds, volume 0-100 (% of the track's level), and withSound false when the clip has no
// audio stream, so the music is all there is.
/** @param {{ length: number, volume: number, withSound: boolean }} options */
export function musicMixFilter({ length, volume, withSound }) {
  if (!(length > 2 * FADE_SECONDS)) throw new Error(`a ${length}s clip is too short for background music`);
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error(`music volume ${volume} is not 0-100`);
  const end = length.toFixed(3);
  const format = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const music =
    `[1:a]${format},atrim=0:${end},asetpts=PTS-STARTPTS,volume=${(volume / 100).toFixed(2)},` +
    `afade=t=in:st=0:d=${FADE_SECONDS},afade=t=out:st=${(length - FADE_SECONDS).toFixed(3)}:d=${FADE_SECONDS}`;
  if (!withSound) return `${music},apad=whole_dur=${end}[aout]`;
  return [
    `${music}[music]`,
    `[0:a]${format},apad=whole_dur=${end},asplit=2[sound][key]`,
    `[music][key]sidechaincompress=threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:attack=${ATTACK_MS}:release=${RELEASE_MS}[ducked]`,
    `[sound][ducked]amix=inputs=2:duration=first:normalize=0[aout]`,
  ].join(";");
}

// The file's length in seconds, and whether it has sound.
export async function probe(file) {
  const stdout = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const info = JSON.parse(stdout);
  const length = Number(info.format?.duration);
  if (!(length > 0)) throw new Error(`could not read the length of ${file}`);
  return { length, withSound: info.streams.some((stream) => stream.codec_type === "audio") };
}

// Writes input with the music mixed under its sound to output. The picture is copied as it is.
/** @param {{ input: string, music: string, volume: number, output: string }} options */
export async function mixBackgroundMusic({ input, music, volume, output }) {
  const { length, withSound } = await probe(input);
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", input,
    "-stream_loop", "-1", "-i", music,
    "-filter_complex", musicMixFilter({ length, volume, withSound }),
    "-map", "0:v:0",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "128k",
    "-t", length.toFixed(3),
    "-movflags", "+faststart",
    output,
  ]);
}
