// "Crop": how a clip's 9:16 picture is taken from its (usually wider) source. "centre" crops the middle, "follow" moves
// the crop with the subject (subject.js) like a camera operator, and "fit" shows the whole frame over a blurred fill of
// itself. A followed stretch that cannot keep everything important in the crop (two faces far apart, or a move faster
// than the camera) is shown fitted instead.
import { UserError } from "../lib/user-error";
import { VERTICAL_FILTER } from "./helpers.js";

export const CROP_MODES = ["centre", "follow", "fit"];

export function parseCropMode(value) {
  if (!CROP_MODES.includes(value)) throw new UserError(`crop must be one of ${CROP_MODES.join(", ")}`);
  return value;
}

// Subjects are looked for this many times per second.
export const SAMPLE_FPS = 4;
// The camera aims where the subject will be this much later, so it leads a move instead of trailing it.
export const LEAD_SECONDS = 0.25;
// The camera starts moving once the subject is further than this share of the crop's width from its centre, and stops
// once it is within SETTLE of it.
export const DEAD_ZONE = 0.12;
const SETTLE = 0.03;
// In source widths per second, and per second squared: how fast the camera may pan and how quickly it may speed up
// or slow down. Within that, it closes FOLLOW_RATE of the distance per second, so it eases into place.
export const MAX_SPEED = 0.5;
const MAX_ACCELERATION = 1.5;
const FOLLOW_RATE = 3;
// How far, as a share of the crop's width, something important may stick out of the crop before the stretch is fitted.
const FIT_TOLERANCE = 0.02;
// Fitted stretches last at least this long, and followed stretches between them too, so the picture does not flicker.
export const MIN_FIT_SECONDS = 1;
const MIN_FOLLOW_SECONDS = 1;

// The width of the 9:16 crop of a width×height source, in pixels, even for the encoder's colour planes.
export function cropPixels(width, height) {
  const crop = Math.min(width, Math.floor((height * 9) / 16));
  return crop - (crop % 2);
}

// The camera along a clip, from its samples ([{ t, subject }], t in seconds from the clip's start, subject as
// subject.js gives it or null). cropWidth is the crop's share of the source's width, cuts the hard cuts' times.
// Returns the crop's centre at every sample as a share of the source's width, with the shot it is in, and the
// stretches to show fitted ([{ start, end }]).
/**
 * @param {{ t: number; subject: { centre: number; left: number; right: number } | null }[]} samples
 * @param {{ cropWidth: number; cuts: number[]; length: number }} options
 */
export function cameraPath(samples, { cropWidth, cuts, length }) {
  if (!(cropWidth > 0 && cropWidth <= 1)) throw new Error(`a crop ${cropWidth} of the source's width is not possible`);
  const half = cropWidth / 2;
  const clamp = (centre) => Math.min(1 - half, Math.max(half, centre));
  const shotOf = (t) => cuts.filter((cut) => cut <= t).length;
  const shots = samples.map(({ t }) => shotOf(t));

  // Samples without a subject keep the one before them in the shot, or else the one after; a shot with none looks
  // at the middle.
  const targets = samples.map(({ subject }) => (subject ? subject.centre : null));
  for (let i = 1; i < targets.length; i++) {
    if (targets[i] === null && shots[i] === shots[i - 1]) targets[i] = targets[i - 1];
  }
  for (let i = targets.length - 2; i >= 0; i--) {
    if (targets[i] === null && shots[i] === shots[i + 1]) targets[i] = targets[i + 1];
  }
  const filled = targets.map((target) => target ?? 0.5);

  // Where the subject is LEAD_SECONDS later in the same shot.
  const ahead = samples.map(({ t }, i) => {
    const at = t + LEAD_SECONDS;
    let j = i;
    while (j + 1 < samples.length && shots[j + 1] === shots[i] && samples[j + 1].t <= at) j++;
    if (j + 1 >= samples.length || shots[j + 1] !== shots[i]) return filled[j];
    const share = (at - samples[j].t) / (samples[j + 1].t - samples[j].t);
    return filled[j] + (filled[j + 1] - filled[j]) * share;
  });

  const centres = [];
  let camera = 0;
  let speed = 0;
  let moving = false;
  samples.forEach(({ t }, i) => {
    if (i === 0 || shots[i] !== shots[i - 1]) {
      // A new shot starts with the camera on its subject, still.
      camera = clamp(ahead[i]);
      speed = 0;
      moving = false;
    } else {
      const dt = t - samples[i - 1].t;
      const error = ahead[i] - camera;
      if (!moving && Math.abs(error) > DEAD_ZONE * cropWidth) moving = true;
      if (moving && Math.abs(error) < SETTLE * cropWidth) moving = false;
      const wanted = moving ? Math.max(-MAX_SPEED, Math.min(MAX_SPEED, error * FOLLOW_RATE)) : 0;
      speed += Math.max(-MAX_ACCELERATION * dt, Math.min(MAX_ACCELERATION * dt, wanted - speed));
      const next = clamp(camera + speed * dt);
      if (next !== camera + speed * dt) speed = 0;
      camera = next;
    }
    centres.push({ t, centre: camera, shot: shots[i] });
  });

  const tolerance = FIT_TOLERANCE * cropWidth;
  const outside = samples.map(({ subject }, i) => {
    if (!subject) return false;
    const { centre } = centres[i];
    return subject.left < centre - half - tolerance || subject.right > centre + half + tolerance;
  });
  return { centres, fit: fitStretches(samples, outside, length) };
}

// The stretches around the flagged samples, joined across short gaps and made at least MIN_FIT_SECONDS long.
export function fitStretches(samples, flagged, length) {
  const step = 1 / SAMPLE_FPS;
  const join = (stretches, gap) => {
    const joined = [];
    for (const stretch of stretches) {
      const last = joined.at(-1);
      if (last && stretch.start - last.end < gap) last.end = Math.max(last.end, stretch.end);
      else joined.push({ ...stretch });
    }
    return joined;
  };
  const raw = samples
    .filter((_, i) => flagged[i])
    .map(({ t }) => ({ start: Math.max(0, t - step / 2), end: Math.min(length, t + step / 2) }));
  const grown = join(raw, MIN_FOLLOW_SECONDS).map(({ start, end }) => {
    const missing = Math.max(0, MIN_FIT_SECONDS - (end - start));
    let from = start - missing / 2;
    let to = end + missing / 2;
    if (from < 0) [from, to] = [0, Math.min(length, to - from)];
    if (to > length) [from, to] = [Math.max(0, from - (to - length)), length];
    return { start: from, end: to };
  });
  // A followed stretch too short to settle at the clip's start or end is fitted too.
  const edged = grown.map(({ start, end }) => ({
    start: start < MIN_FOLLOW_SECONDS ? 0 : start,
    end: length - end < MIN_FOLLOW_SECONDS ? length : end,
  }));
  return join(edged, MIN_FOLLOW_SECONDS);
}

// The crop's left edge in source pixels through the clip, [{ t, x }], straight lines between the samples. At a cut the
// camera holds until the cut and jumps there: two points at the cut's time.
export function cropKeyframes(centres, { width, crop, cuts }) {
  const left = (centre) => Math.round(Math.min(width - crop, Math.max(0, centre * width - crop / 2)));
  const keyframes = [];
  centres.forEach((point, i) => {
    const previous = centres[i - 1];
    if (previous && previous.shot !== point.shot) {
      const cut = cuts.filter((time) => time > previous.t && time <= point.t).at(-1);
      if (cut === undefined) throw new Error(`no cut between ${previous.t}s and ${point.t}s`);
      keyframes.push({ t: cut, x: left(previous.centre) }, { t: cut, x: left(point.centre) });
    }
    keyframes.push({ t: point.t, x: left(point.centre) });
  });
  return keyframes;
}

const number = (value) => String(Math.round(value * 1000) / 1000);

// ffmpeg sendcmd commands that move the crop named target along keyframes, one straight line per stretch, so the
// crop's x changes on every frame. Arguments have no spaces or commas, which end them in sendcmd.
export function cropCommands(keyframes, target = "crop@follow") {
  const lines = [];
  let last = null;
  keyframes.forEach((from, i) => {
    const to = keyframes[i + 1];
    if (to && to.t === from.t) return;
    const slope = to ? (to.x - from.x) / (to.t - from.t) : 0;
    const x = slope === 0 ? number(from.x) : `${number(from.x)}${slope < 0 ? "-" : "+"}${number(Math.abs(slope))}*(t-${number(from.t)})`;
    if (x === last) return;
    lines.push(`${from.t.toFixed(3)} ${target} x ${x};`);
    last = x;
  });
  return lines.join("\n") + "\n";
}

// The whole frame, scaled to fit 1080×1920, over a blurred fill of itself. from and to are filter labels; prefix keeps
// its own labels apart.
function fitGraph(from, to, prefix) {
  return [
    `[${from}]split[${prefix}front][${prefix}back]`,
    `[${prefix}back]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:2,scale=1080:1920,setsar=1[${prefix}fill]`,
    `[${prefix}front]scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[${prefix}whole]`,
    `[${prefix}fill][${prefix}whole]overlay=(W-w)/2:(H-h)/2[${to}]`,
  ].join(";");
}

// The filters that make the 1080×1920 picture from [0:v] on the source's own time, ending in [to]. crop is
// { mode: "centre" }, { mode: "fit" } or a followed crop: { mode: "follow", width (the crop's, in pixels), keyframes,
// fit }, whose crop is moved by commands, the name of its sendcmd file (cropCommands) in ffmpeg's working folder.
/**
 * @param {Crop} crop
 * @param {string} to
 * @param {string | null} [commands]
 */
export function framingFilter(crop, to, commands = null) {
  if (crop.mode === "centre") return `[0:v]${VERTICAL_FILTER}[${to}]`;
  if (crop.mode === "fit") return fitGraph("0:v", to, "fit");
  if (crop.mode !== "follow") throw new Error(`unknown crop "${crop.mode}"`);
  if (!commands || !/^[\w.-]+$/.test(commands)) throw new Error(`crop commands file "${commands}" needs a plain name`);
  if (crop.keyframes.length === 0) throw new Error("a followed crop has no keyframes");
  const follow = `crop@follow=w=${crop.width}:h=ih:x=${crop.keyframes[0].x}:y=0,scale=1080:1920,setsar=1`;
  if (crop.fit.length === 0) return `[0:v]sendcmd=f=${commands},${follow}[${to}]`;
  const enable = crop.fit.map(({ start, end }) => `between(t,${number(start)},${number(end)})`).join("+");
  return [
    `[0:v]sendcmd=f=${commands},split[followsrc][fitsrc]`,
    `[followsrc]${follow}[followed]`,
    fitGraph("fitsrc", "fitted", "fit"),
    `[followed][fitted]overlay=enable='${enable}'[${to}]`,
  ].join(";");
}

/**
 * @typedef {{ mode: "centre" } | { mode: "fit" } | { mode: "follow"; width: number; keyframes: { t: number; x: number }[];
 *   fit: { start: number; end: number }[] }} Crop
 */
