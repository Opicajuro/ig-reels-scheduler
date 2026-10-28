import { spawn } from "node:child_process";
import {
  AUDIO_SAMPLE_RATE,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  parseProbeDuration,
  SAMPLES_PER_SECOND,
  VERTICAL_FILTER,
} from "./helpers.js";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
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

async function* rawOutput(input, outputArgs) {
  const child = spawn("ffmpeg", ["-v", "error", "-i", input, ...outputArgs, "pipe:1"]);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const finished = new Promise((resolve) => {
    child.on("error", (err) => resolve(err.message));
    child.on("close", (code) => {
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      resolve(code === 0 ? null : `exit ${code}: ${tail}`);
    });
  });
  yield* child.stdout;
  const failure = await finished;
  if (failure) throw new Error(`ffmpeg failed: ${failure}`);
}

export function motionFrames(input) {
  return rawOutput(input, [
    "-map", "0:v:0",
    "-vf", `fps=${SAMPLES_PER_SECOND},scale=${MOTION_WIDTH}:${MOTION_HEIGHT},format=gray`,
    "-f", "rawvideo",
  ]);
}

export function audioSamples(input) {
  return rawOutput(input, [
    "-map", "0:a:0?",
    "-vn",
    "-ac", "1",
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-f", "s16le",
  ]);
}

export async function probeDuration(file) {
  const stdout = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", file]);
  return parseProbeDuration(JSON.parse(stdout));
}

// The transparent frame shown between captions.
export async function renderBlankOverlay(output) {
  await run("ffmpeg", [
    "-y",
    "-v", "error",
    "-f", "lavfi",
    "-i", "color=c=black@0:s=1080x1920,format=rgba",
    "-frames:v", "1",
    output,
  ]);
}

// An ffconcat list that shows each overlay image from start to end (seconds from the start of the clip) and the
// blank image everywhere else, so the whole clip is one timed overlay stream.
export function overlayList({ overlays, blank, length }) {
  const lines = ["ffconcat version 1.0"];
  // An image's timestamps count in frames of its frame rate (25 by default); 1000 makes them exact to the ms.
  const show = (image, duration) =>
    lines.push(`file ${quoteConcatPath(image)}`, "option framerate 1000", `duration ${duration.toFixed(3)}`);
  let cursor = 0;
  for (const overlay of overlays) {
    if (overlay.start < cursor) throw new Error(`overlay at ${overlay.start}s overlaps the one before it`);
    if (overlay.start > cursor) show(blank, overlay.start - cursor);
    show(overlay.image, overlay.end - overlay.start);
    cursor = overlay.end;
  }
  if (cursor < length) show(blank, length - cursor);
  // The demuxer only honours the last duration if the last file is listed once more.
  lines.push(...lines.slice(-3, -1));
  return lines.join("\n") + "\n";
}

function quoteConcatPath(file) {
  return `'${file.replaceAll("'", "'\\''")}'`;
}

// A finished clip, as it is uploaded. overlay is an ffconcat list from overlayList, or null for no overlay.
export async function renderClip({ input, output, start, length, overlay }) {
  const video = overlay
    ? ["-f", "concat", "-safe", "0", "-i", overlay, "-filter_complex", `[0:v]${VERTICAL_FILTER}[v];[v][1:v]overlay[out]`]
    : ["-filter_complex", `[0:v]${VERTICAL_FILTER}[out]`];
  await run("ffmpeg", [
    "-y",
    "-v", "error",
    "-ss", String(start),
    "-i", input,
    ...video,
    "-t", String(length),
    "-map", "[out]",
    "-map", "0:a?",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "21",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
}
