import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cropCommands, framingFilter } from "./crop.js";
import { videoEncoder, videoEncoderArgs } from "./encoder.js";
import { FPS } from "./pacing.js";
import {
  AUDIO_SAMPLE_RATE,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  parseProbeDuration,
  SAMPLES_PER_SECOND,
  VERTICAL_FILTER,
} from "./helpers.js";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
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

async function* rawOutput(input, outputArgs, inputArgs = []) {
  const child = spawn("ffmpeg", ["-v", "error", ...inputArgs, "-i", input, ...outputArgs, "pipe:1"]);
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

// A clip's stretch of the source as BGR frames (bgr24) of width×height, fps of them per second.
export async function* sampledFrames({ input, start, length, width, height, fps }) {
  const size = width * height * 3;
  let pending = Buffer.alloc(0);
  const stream = rawOutput(
    input,
    ["-map", "0:v:0", "-vf", `fps=${fps},scale=${width}:${height}`, "-pix_fmt", "bgr24", "-f", "rawvideo"],
    ["-ss", String(start), "-t", String(length)],
  );
  for await (const chunk of stream) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= size) {
      yield { data: pending.subarray(0, size), width, height };
      pending = pending.subarray(size);
    }
  }
}

// The hard cuts in a clip's stretch of the source, in seconds from its start, by ffmpeg's scene change score.
export async function sceneCuts({ input, start, length, threshold = 0.4 }) {
  const stdout = await run("ffmpeg", [
    "-v", "error",
    "-ss", String(start),
    "-t", String(length),
    "-i", input,
    "-map", "0:v:0",
    "-vf", `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
    "-f", "null", "-",
  ]);
  return [...stdout.matchAll(/pts_time:([\d.]+)/g)].map((match) => Number(match[1])).filter((time) => time > 0);
}

// The width and height the source's picture shows at, after its rotation.
export async function probeVideoSize(file) {
  const stdout = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-print_format", "json", "-show_streams", file]);
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream || !(stream.width > 0) || !(stream.height > 0)) throw new Error(`${file} has no video stream with a size`);
  const rotation = Number(stream.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  return Math.abs(rotation) % 180 === 90 ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
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

export const HOOK_SECONDS = 2;
export const END_CARD_SECONDS = 1.5;
const PROGRESS_BAR_HEIGHT = 12;

// The inputs and filters that make a clip's picture, each part laid over the one before: the captions (an ffconcat
// list from overlayList), the hook title PNG for the first HOOK_SECONDS, the end card PNG for the last
// END_CARD_SECONDS, then a progress bar along the bottom, a strip of progressColor ("#rrggbb") that slides in as the
// clip plays. Every part is optional (null). The source is input 0.
// The picture is framed by crop (crop.js) on the source's own time, with its sendcmd file named commands for a
// followed crop. With keep (tightenFilters), the framed picture is then cut down to those pieces and length is the
// tightened one, so a followed crop moves with the source and not with the cuts.
export function clipVideoArgs({ length, overlay, hook, endCard, progressColor, keep = null, crop = CENTRE, commands = null }) {
  if (endCard && length <= END_CARD_SECONDS) throw new Error(`a ${length}s clip is too short for an end card`);
  const inputs = [];
  const filters = keep
    ? [framingFilter(crop, "framed", commands), `[framed]${tightenFilters(keep).video}[base]`]
    : [framingFilter(crop, "base", commands)];
  let last = "base";
  const layer = (filter) => {
    const label = `v${filters.length}`;
    filters.push(`[${last}]${filter}[${label}]`);
    last = label;
  };
  const image = (args) => {
    inputs.push(...args);
    return `[${inputs.filter((arg) => arg === "-i").length}:v]`;
  };
  if (overlay) {
    layer(`${image(["-f", "concat", "-safe", "0", "-i", overlay])}overlay`);
  }
  if (hook) {
    layer(`${image(["-loop", "1", "-i", hook])}overlay=enable='lt(t,${HOOK_SECONDS})'`);
  }
  if (endCard) {
    layer(`${image(["-loop", "1", "-i", endCard])}overlay=enable='gte(t,${length - END_CARD_SECONDS})'`);
  }
  if (progressColor) {
    if (!/^#[0-9a-f]{6}$/i.test(progressColor)) throw new Error(`progress bar colour "${progressColor}" is not #rrggbb`);
    // drawbox sizes its box once, so the bar is a strip moved along by overlay, whose x is worked out every frame.
    filters.push(`color=c=0x${progressColor.slice(1)}:s=1080x${PROGRESS_BAR_HEIGHT}:r=30[bar]`);
    layer(`[bar]overlay=x='W*t/${length}-w':y=H-h:eval=frame:shortest=1`);
  }
  filters[filters.length - 1] = filters.at(-1).replace(/\[[^\]]+\]$/, "[out]");
  return { inputs, filter: filters.join(";") };
}

const CENTRE = { mode: "centre" };

export const CROSSFADE_SECONDS = 0.02;

// The filters that keep only the pieces in keep ([{ start, end }] seconds from the clip's start, on the FPS frame grid,
// from tightenClip). The picture is made constant FPS and select keeps whole frames by number, so no frame is torn and
// each piece is exactly its length. select keeps one stream, so nothing is buffered. Each piece of sound is cut
// sample-exactly with atrim and joined with a CROSSFADE_SECONDS crossfade against clicks: every piece but the last
// takes CROSSFADE_SECONDS more of the source, which the crossfade overlaps again, so the sound is exactly as long as
// the picture and stays in sync after every cut. (aselect would cut on whole audio frames, which drift from the video
// frames, and cannot crossfade.) video goes on [0:v]; audio reads [0:a] and ends in [aout].
export function tightenFilters(keep) {
  if (keep.length === 0) throw new Error("tightening keeps nothing");
  const frame = (seconds) => {
    const index = Math.round(seconds * FPS);
    if (Math.abs(index - seconds * FPS) > 1e-6) throw new Error(`${seconds}s is not on the ${FPS} fps frame grid`);
    return index;
  };
  const pieces = keep.map((piece, index) => {
    if (piece.end <= piece.start || (index > 0 && piece.start <= keep[index - 1].end)) {
      throw new Error("the kept pieces must be in order, apart and not empty");
    }
    return { from: frame(piece.start), to: frame(piece.end) };
  });
  const select = pieces.map(({ from, to }) => `between(n,${from},${to - 1})`).join("+");
  const video = `fps=${FPS},select='${select}',setpts=N/${FPS}/TB`;
  const trim = ({ from, to }, index) => {
    const extra = index < pieces.length - 1 ? CROSSFADE_SECONDS : 0;
    return `atrim=start=${(from / FPS).toFixed(6)}:end=${(to / FPS + extra).toFixed(6)},asetpts=PTS-STARTPTS`;
  };
  if (pieces.length === 1) return { video, audio: `[0:a]${trim(pieces[0], 0)}[aout]` };
  const audio = [`[0:a]asplit=${pieces.length}${pieces.map((_, index) => `[as${index}]`).join("")}`];
  pieces.forEach((piece, index) => audio.push(`[as${index}]${trim(piece, index)}[at${index}]`));
  let last = "at0";
  for (let index = 1; index < pieces.length; index++) {
    const label = index === pieces.length - 1 ? "aout" : `ax${index}`;
    audio.push(`[${last}][at${index}]acrossfade=d=${CROSSFADE_SECONDS}:c1=tri:c2=tri[${label}]`);
    last = label;
  }
  return { video, audio: audio.join(";") };
}

// A finished clip, as it is uploaded. overlay is an ffconcat list from overlayList, or null for no overlay; hook,
// endCard and progressColor are as clipVideoArgs takes them.
// With tightened ({ keep, length } from tightenClip, for this clip's start and length), only the kept pieces are
// used and the clip is tightened.length long; overlay, hook and end card are then timed in tightened time.
// crop (crop.js) frames the picture, the centre by default; a followed crop's commands are written next to output.
/**
 * @param {{ input: string; output: string; start: number; length: number; overlay: string | null; hook?: string | null;
 *   endCard?: string | null; progressColor?: string | null; tightened?: { keep: { start: number; end: number }[];
 *   length: number } | null; crop?: import("./crop.js").Crop }} options
 */
export async function renderClip({
  input,
  output,
  start,
  length,
  overlay,
  hook = null,
  endCard = null,
  progressColor = null,
  tightened = null,
  crop = CENTRE,
}) {
  const outputLength = tightened ? tightened.length : length;
  const keep = tightened ? tightened.keep : null;
  // ffmpeg then runs in the output's folder and reads the commands by their plain name, so no path is quoted in the
  // filter. Every other path it is given is absolute.
  for (const file of [input, output, overlay, hook, endCard]) {
    if (crop.mode === "follow" && file && !path.isAbsolute(file)) throw new Error(`a followed crop needs absolute paths, not ${file}`);
  }
  const commands = crop.mode === "follow" ? `${path.basename(output, ".mp4")}.crop.cmd` : null;
  if (commands) await writeFile(path.join(path.dirname(output), commands), cropCommands(crop.keyframes));
  const video = clipVideoArgs({ length: outputLength, overlay, hook, endCard, progressColor, keep, crop, commands });
  const filter = keep ? `${video.filter};${tightenFilters(keep).audio}` : video.filter;
  await run("ffmpeg", [
    "-y",
    "-v", "error",
    "-ss", String(start),
    // Tightened, the source is read no further than the clip.
    ...(keep ? ["-t", String(length)] : []),
    "-i", input,
    ...video.inputs,
    "-filter_complex", filter,
    "-t", String(outputLength),
    "-map", "[out]",
    ...(keep ? ["-map", "[aout]"] : ["-map", "0:a?"]),
    ...videoEncoderArgs(await videoEncoder(), 21),
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ], commands ? { cwd: path.dirname(path.resolve(output)) } : {});
}

// An AI video, as it is uploaded: 1080×1920 at 30 fps in H.264, with a silent AAC track, because Instagram wants an
// audio stream and the model makes none.
export async function convertAiVideo({ input, output }) {
  await run("ffmpeg", [
    "-y",
    "-v", "error",
    "-i", input,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex", `[0:v]${VERTICAL_FILTER},fps=30,format=yuv420p[out]`,
    "-map", "[out]",
    "-map", "1:a",
    "-shortest",
    ...videoEncoderArgs(await videoEncoder(), 20),
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
}
