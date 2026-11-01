import { spawn } from "node:child_process";
import { videoEncoder, videoEncoderArgs } from "./encoder.js";

// A slideshow as one 1080×1920, 30 fps clip: each picture slowly zooms in or pans (ffmpeg's zoompan, every other slide
// the other move), with 0.4 s crossfades, under the voice. A slide lasts its spoken line plus 0.3 s; the crossfade
// into the next slide starts when it ends, so the voice of each slide starts as its picture fades in.

export const SLIDESHOW_WIDTH = 1080;
export const SLIDESHOW_HEIGHT = 1920;
export const SLIDESHOW_FPS = 30;
export const CROSSFADE_SECONDS = 0.4;
export const SLIDE_PAUSE_SECONDS = 0.3;
const CROSSFADE_FRAMES = Math.round(CROSSFADE_SECONDS * SLIDESHOW_FPS);
// The picture is scaled to twice the output size before zoompan, which moves in whole pixels: at the output size the
// slow moves would judder.
const ZOOM_SOURCE = `scale=${SLIDESHOW_WIDTH * 2}:${SLIDESHOW_HEIGHT * 2}`;
const MAX_ZOOM = 1.15;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().split("\n").slice(-5).join("\n")}`));
    });
  });
}

// Each slide's place on the timeline, in whole frames: it starts at `start` (seconds) and shows for `frames` frames,
// which for every slide but the last includes the crossfade into the next one. total is the clip's length in seconds.
/** @param {number[]} voiceSeconds */
export function slideTimings(voiceSeconds) {
  if (voiceSeconds.length === 0) throw new Error("a slideshow needs at least one slide");
  let cursor = 0;
  const slides = voiceSeconds.map((seconds, index) => {
    if (!(seconds > 0)) throw new Error(`the voice of slide ${index + 1} is empty`);
    const slot = Math.round((seconds + SLIDE_PAUSE_SECONDS) * SLIDESHOW_FPS);
    const last = index === voiceSeconds.length - 1;
    const slide = { start: cursor / SLIDESHOW_FPS, slot: slot / SLIDESHOW_FPS, frames: slot + (last ? 0 : CROSSFADE_FRAMES) };
    cursor += slot;
    return slide;
  });
  return { slides, total: cursor / SLIDESHOW_FPS };
}

// The Ken Burns move of slide index over its frames: even slides zoom in to the centre, odd ones pan from left to
// right at a fixed zoom.
function kenBurns(index, frames) {
  const last = Math.max(frames - 1, 1);
  const centreY = "ih/2-(ih/zoom/2)";
  const move =
    index % 2 === 0
      ? `z='1+${(MAX_ZOOM - 1).toFixed(2)}*on/${last}':x='iw/2-(iw/zoom/2)':y='${centreY}'`
      : `z='${MAX_ZOOM}':x='(iw-iw/zoom)*on/${last}':y='${centreY}'`;
  return `zoompan=${move}:d=${frames}:s=${SLIDESHOW_WIDTH}x${SLIDESHOW_HEIGHT}:fps=${SLIDESHOW_FPS}`;
}

// The filter graph for inputs 0..n-1 (the pictures, 1080×1920 stills) and, with captions, input n + 1 (the caption
// overlay stream; input n is the voice). Its video output is [out].
/** @param {{ timings: ReturnType<typeof slideTimings>, captions: boolean }} options */
export function slideshowFilter({ timings, captions }) {
  const { slides } = timings;
  const parts = slides.map(
    (slide, index) => `[${index}:v]${ZOOM_SOURCE},${kenBurns(index, slide.frames)},setsar=1,format=yuv420p,settb=AVTB[s${index}]`,
  );
  let previous = "s0";
  for (let index = 1; index < slides.length; index++) {
    const label = `x${index}`;
    parts.push(
      `[${previous}][s${index}]xfade=transition=fade:duration=${CROSSFADE_SECONDS}:offset=${slides[index].start.toFixed(3)}[${label}]`,
    );
    previous = label;
  }
  if (captions) {
    parts.push(`[${previous}][${slides.length + 1}:v]overlay[out]`);
  } else {
    parts.push(`[${previous}]null[out]`);
  }
  return parts.join(";");
}

// One voice track for the whole slideshow: each line, then silence until its slide's slot ends. 48 kHz stereo WAV.
/** @param {{ lines: string[], timings: ReturnType<typeof slideTimings>, output: string }} options */
export async function buildVoiceTrack({ lines, timings, output }) {
  if (lines.length !== timings.slides.length) throw new Error("every slide needs its voice line");
  const inputs = lines.flatMap((line) => ["-i", line]);
  const padded = timings.slides.map(
    (slide, index) => `[${index}:a]aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${slide.slot.toFixed(3)}[a${index}]`,
  );
  const concat = `${timings.slides.map((_, index) => `[a${index}]`).join("")}concat=n=${lines.length}:v=0:a=1[voice]`;
  await run([
    "-y", "-v", "error",
    ...inputs,
    "-filter_complex", [...padded, concat].join(";"),
    "-map", "[voice]",
    "-c:a", "pcm_s16le",
    output,
  ]);
}

// A picture of any size as a 1080×1920 still, cropped to fill. With at, the frame of a video at that second.
/** @param {{ input: string, output: string, at?: number }} options */
export async function preparePicture({ input, output, at }) {
  await run([
    "-y", "-v", "error",
    ...(at === undefined ? [] : ["-ss", at.toFixed(3)]),
    "-i", input,
    "-frames:v", "1",
    "-vf", `scale=${SLIDESHOW_WIDTH}:${SLIDESHOW_HEIGHT}:force_original_aspect_ratio=increase,crop=${SLIDESHOW_WIDTH}:${SLIDESHOW_HEIGHT},setsar=1`,
    output,
  ]);
}

// The finished slideshow, as it is uploaded. overlay is an ffconcat list from overlayList for the captions, or null.
/**
 * @param {{ pictures: string[], voice: string, timings: ReturnType<typeof slideTimings>, overlay: string | null,
 *   output: string }} options
 */
export async function renderSlideshow({ pictures, voice, timings, overlay, output }) {
  if (pictures.length !== timings.slides.length) throw new Error("every slide needs its picture");
  await run([
    "-y", "-v", "error",
    ...pictures.flatMap((picture) => ["-i", picture]),
    "-i", voice,
    ...(overlay ? ["-f", "concat", "-safe", "0", "-i", overlay] : []),
    "-filter_complex", slideshowFilter({ timings, captions: overlay !== null }),
    "-map", "[out]",
    "-map", `${pictures.length}:a`,
    "-t", timings.total.toFixed(3),
    "-r", String(SLIDESHOW_FPS),
    ...videoEncoderArgs(await videoEncoder(), 21),
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output,
  ]);
}
