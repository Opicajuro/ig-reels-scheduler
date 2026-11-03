import { spawn } from "node:child_process";
import { videoEncoder, videoEncoderArgs } from "./encoder.js";

// The ffmpeg steps of an AI intro or B-roll made from an existing clip: its start picture, and joining the AI shot
// to the clip.

// Clips are 1080×1920 at 30 fps; the AI shot (704×1280) is fitted inside that frame.
const FIT_FILTER = "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p";
// The intro's silence and the clip's sound are both brought to this, so clips with other rates or channels join.
const AUDIO_FORMAT = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/** @param {string[]} args @returns {Promise<string>} */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      reject(new Error(`${command} exited with ${code}: ${tail}`));
    });
  });
}

// The clip's length in seconds and whether it has a sound track.
/** @param {string} file @returns {Promise<{ duration: number; hasAudio: boolean }>} */
export async function probeClip(file) {
  const probe = JSON.parse(await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]));
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`ffprobe found no duration in ${file}`);
  return { duration, hasAudio: probe.streams.some((/** @type {{ codec_type: string }} */ stream) => stream.codec_type === "audio") };
}

// The frame at `at` seconds into the clip, as a PNG.
/** @param {{ input: string; at: number; output: string }} options */
export async function extractFrame({ input, at, output }) {
  await run("ffmpeg", ["-y", "-v", "error", "-ss", at.toFixed(3), "-i", input, "-frames:v", "1", output]);
}

// The AI shot, cut to `seconds` and with silence under it, followed by the whole clip.
/** @param {{ intro: string; seconds: number; clip: string; output: string }} options */
export async function joinIntro({ intro, seconds, clip, output }) {
  if (!(await probeClip(clip)).hasAudio) throw new Error("the clip has no sound track");
  await run("ffmpeg", [
    "-y",
    "-v", "error",
    "-i", intro,
    "-i", clip,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex",
    [
      `[0:v]trim=duration=${seconds},setpts=PTS-STARTPTS,${FIT_FILTER}[iv]`,
      `[2:a]atrim=duration=${seconds},${AUDIO_FORMAT}[ia]`,
      `[1:v]${FIT_FILTER}[cv]`,
      `[1:a]${AUDIO_FORMAT}[ca]`,
      "[iv][ia][cv][ca]concat=n=2:v=1:a=1[v][a]",
    ].join(";"),
    "-map", "[v]",
    "-map", "[a]",
    ...videoEncoderArgs(await videoEncoder(), 20),
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    output,
  ]);
}

// The clip with the AI shot covering its picture from `at` for `seconds`; the sound is the clip's own, untouched.
/** @param {{ clip: string; shot: string; at: number; seconds: number; output: string }} options */
export async function overlayBroll({ clip, shot, at, seconds, output }) {
  if (!(await probeClip(clip)).hasAudio) throw new Error("the clip has no sound track");
  const end = at + seconds;
  await run("ffmpeg", [
    "-y",
    "-v", "error",
    "-i", clip,
    "-i", shot,
    "-filter_complex",
    [
      `[0:v]${FIT_FILTER}[base]`,
      `[1:v]trim=duration=${seconds},setpts=PTS-STARTPTS,${FIT_FILTER},setpts=PTS+${at}/TB[shot]`,
      `[base][shot]overlay=enable='between(t,${at},${end})':eof_action=pass[v]`,
    ].join(";"),
    "-map", "[v]",
    "-map", "0:a",
    ...videoEncoderArgs(await videoEncoder(), 20),
    "-c:a", "copy",
    "-movflags", "+faststart",
    output,
  ]);
}
