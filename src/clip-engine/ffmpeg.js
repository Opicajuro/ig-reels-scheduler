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

function encodeVertical({ input, output, start, length, preset, crf }) {
  return run("ffmpeg", [
    "-y",
    "-v", "error",
    "-ss", String(start),
    "-i", input,
    "-t", String(length),
    "-vf", VERTICAL_FILTER,
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", crf,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
}

// A finished clip, as it is uploaded.
export async function renderClip({ input, output, start, length }) {
  await encodeVertical({ input, output, start, length, preset: "veryfast", crf: "21" });
}

// A cut that only feeds the caption render, which encodes it again: fast to make, with quality to spare.
export async function cutForCaptions({ input, output, start, length }) {
  await encodeVertical({ input, output, start, length, preset: "ultrafast", crf: "16" });
}
