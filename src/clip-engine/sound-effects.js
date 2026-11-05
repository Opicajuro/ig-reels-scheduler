import { probe, run } from "./music.js";

// Sound effects over a finished clip. Each sound starts at its time (adelay), at its own volume (% of the file's
// level), over the clip's sound and music, which are not ducked for it. The sum is kept as it is (amix normalize=0) and
// alimiter holds its peaks under LIMIT, so a loud sound over loud speech does not clip. The picture is copied and the
// clip keeps its length: a sound near the end is cut off there.

export const LIMIT = 0.95;
const FORMAT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

// The filter graph that mixes inputs 1 to files.length (the sound files) over input 0's sound into [aout]. sounds are
// { file, time, volume }: file indexes files, time is seconds from the clip's start and volume 0-100. withSound is false
// when the clip has no audio stream, so the sounds play over silence.
/** @param {{ length: number, files: string[], sounds: { file: number, time: number, volume: number }[], withSound: boolean }} options */
export function soundEffectsFilter({ length, files, sounds, withSound }) {
  if (!(length > 0)) throw new Error(`a ${length}s clip cannot get sound effects`);
  if (sounds.length === 0) throw new Error("no sound effects to mix");
  const end = length.toFixed(3);
  const parts = [];
  const copies = files.map(() => []);
  sounds.forEach((sound, index) => {
    if (!Number.isInteger(sound.file) || !files[sound.file]) throw new Error(`sound effect ${index + 1} has no file`);
    if (!Number.isInteger(sound.volume) || sound.volume < 0 || sound.volume > 100) {
      throw new Error(`sound effect volume ${sound.volume} is not 0-100`);
    }
    if (!(sound.time >= 0 && sound.time < length)) throw new Error(`sound effect at ${sound.time}s is outside the ${length}s clip`);
    copies[sound.file].push(index);
  });
  copies.forEach((indexes, file) => {
    if (indexes.length === 0) throw new Error(`the sound file ${files[file]} is not used`);
    parts.push(`[${file + 1}:a]${FORMAT},asplit=${indexes.length}${indexes.map((index) => `[f${index}]`).join("")}`);
  });
  sounds.forEach((sound, index) => {
    const delay = Math.round(sound.time * 1000);
    parts.push(`[f${index}]volume=${(sound.volume / 100).toFixed(2)},adelay=${delay}:all=1[s${index}]`);
  });
  parts.push(
    withSound
      ? `[0:a]${FORMAT},apad=whole_dur=${end}[base]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${end},aformat=sample_fmts=fltp[base]`,
  );
  const inputs = ["[base]", ...sounds.map((_, index) => `[s${index}]`)].join("");
  parts.push(
    `${inputs}amix=inputs=${sounds.length + 1}:duration=first:normalize=0,alimiter=limit=${LIMIT}:level=0:latency=1[aout]`,
  );
  return parts.join(";");
}

// Writes input with the sounds ({ file, time, volume }, file a path) mixed over its sound to output.
/** @param {{ input: string, sounds: { file: string, time: number, volume: number }[], output: string }} options */
export async function mixSoundEffects({ input, sounds, output }) {
  const { length, withSound } = await probe(input);
  const files = [...new Set(sounds.map((sound) => sound.file))];
  const filter = soundEffectsFilter({
    length,
    files,
    sounds: sounds.map((sound) => ({ ...sound, file: files.indexOf(sound.file) })),
    withSound,
  });
  await run("ffmpeg", [
    "-y", "-v", "error",
    "-i", input,
    ...files.flatMap((file) => ["-i", file]),
    "-filter_complex", filter,
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
