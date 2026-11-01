import { spawn } from "node:child_process";

/** @typedef {"nvenc" | "amf" | "x264"} VideoEncoder */

// Instagram takes Reels up to 25 Mbps; the cap keeps busy scenes under it with either encoder.
const BITRATE_CAP = ["-maxrate", "20M", "-bufsize", "40M"];

// The H.264 encoder settings every encode uses. quality is x264's CRF, NVENC's CQ or AMF's QVBR level, on the same
// 0-51 scale (AMF's starts at 1).
/** @param {VideoEncoder} encoder @param {number} quality @returns {string[]} */
export function videoEncoderArgs(encoder, quality) {
  if (encoder === "amf") {
    // QVBR is AMF's constant-quality mode that still keeps the peak bitrate cap (CQP fixes the QP and ignores the cap).
    // Its level is on the QP scale, lower is better, and AMF runs it only with pre-analysis on.
    return [
      "-c:v", "h264_amf",
      "-profile:v", "high",
      "-usage", "transcoding",
      "-quality", "quality",
      "-rc", "qvbr",
      "-qvbr_quality_level", String(quality),
      "-preanalysis", "1",
      ...BITRATE_CAP,
      "-pix_fmt", "yuv420p",
    ];
  }
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

// AMD's encoder line, such as " V....D h264_amf             AMD AMF H.264 Encoder (codec h264)".
/** @param {string} stdout */
export function listsAmf(stdout) {
  return /^\s*V\S*\s+h264_amf\s/m.test(stdout);
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

// A short encode with the settings the clips use, which only works when the graphics card and its driver can do it.
/** @param {VideoEncoder} encoder */
async function encodes(encoder) {
  const test = await ffmpeg([
    "-hide_banner", "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.2",
    ...videoEncoderArgs(encoder, 23),
    "-f", "null", "-",
  ]);
  return test.code === 0;
}

// NVENC, then AMD's AMF, then x264: the first one this ffmpeg lists that also makes a test encode. An ffmpeg build lists
// h264_nvenc and h264_amf on any PC, card or not, so only a real encode tells.
/** @returns {Promise<VideoEncoder>} */
export async function detectVideoEncoder() {
  const list = await ffmpeg(["-hide_banner", "-encoders"]);
  if (list.code !== 0) throw new Error(`ffmpeg -encoders exited with ${list.code}: ${list.stderr.trim()}`);
  if (listsNvenc(list.stdout) && (await encodes("nvenc"))) return "nvenc";
  if (listsAmf(list.stdout) && (await encodes("amf"))) return "amf";
  return "x264";
}

/** @type {Promise<VideoEncoder> | undefined} */
let detected;

// Detected once per process: the worker asks at start, and every encode after that gets the same answer.
export function videoEncoder() {
  detected ??= detectVideoEncoder();
  return detected;
}
