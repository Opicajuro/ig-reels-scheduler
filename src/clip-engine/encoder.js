import { spawn } from "node:child_process";

/** @typedef {"nvenc" | "x264"} VideoEncoder */

// Instagram takes Reels up to 25 Mbps; the cap keeps busy scenes under it with either encoder.
const BITRATE_CAP = ["-maxrate", "20M", "-bufsize", "40M"];

// The H.264 encoder settings every encode uses. quality is x264's CRF or NVENC's CQ, on the same 0-51 scale.
/** @param {VideoEncoder} encoder @param {number} quality @returns {string[]} */
export function videoEncoderArgs(encoder, quality) {
  if (encoder === "nvenc") {
    return [
      "-c:v", "h264_nvenc",
      "-profile:v", "high",
      "-preset", "p5",
      "-tune", "hq",
      "-rc", "vbr",
      "-cq", String(quality),
      "-b:v", "0",
      ...BITRATE_CAP,
      "-pix_fmt", "yuv420p",
    ];
  }
  return [
    "-c:v", "libx264",
    "-profile:v", "high",
    "-preset", "veryfast",
    "-crf", String(quality),
    ...BITRATE_CAP,
    "-pix_fmt", "yuv420p",
  ];
}

// The output of `ffmpeg -encoders` has one line per encoder, such as " V....D h264_nvenc   NVIDIA NVENC H.264 encoder".
/** @param {string} stdout */
export function listsNvenc(stdout) {
  return /^\s*V\S*\s+h264_nvenc\s/m.test(stdout);
}

/** @param {string[]} args @returns {Promise<{ code: number | null; stdout: string; stderr: string }>} */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// NVENC when this ffmpeg has it and a test encode works, x264 otherwise. An ffmpeg build can list h264_nvenc on a PC
// without an NVIDIA card or driver, so only a real encode tells.
/** @returns {Promise<VideoEncoder>} */
export async function detectVideoEncoder() {
  const list = await ffmpeg(["-hide_banner", "-encoders"]);
  if (list.code !== 0) throw new Error(`ffmpeg -encoders exited with ${list.code}: ${list.stderr.trim()}`);
  if (!listsNvenc(list.stdout)) return "x264";
  const test = await ffmpeg([
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.2",
    "-c:v", "h264_nvenc",
    "-f", "null", "-",
  ]);
  return test.code === 0 ? "nvenc" : "x264";
}

/** @type {Promise<VideoEncoder> | undefined} */
let detected;

// Detected once per process: the worker asks at start, and every encode after that gets the same answer.
export function videoEncoder() {
  detected ??= detectVideoEncoder();
  return detected;
}
