import { CAPTION_POSITION_NAMES, CAPTION_PRESET_NAMES } from "./remotion/caption-presets.js";

export const MIN_CLIP_SECONDS = 15;
export const MAX_CLIP_SECONDS = 180;
export const MIN_SEGMENT_SECONDS = 3;
export const MAX_CLIPS = 10;
export const VERTICAL_FILTER = "crop=min(iw\\,ih*9/16):min(ih\\,iw*16/9),scale=1080:1920";

export const MOTION_WIDTH = 160;
export const MOTION_HEIGHT = 90;
export const SAMPLES_PER_SECOND = 4;
export const AUDIO_SAMPLE_RATE = 8000;
export const AUDIO_WEIGHT = 0.6;
export const MOTION_WEIGHT = 0.4;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "link must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "link must start with http:// or https://");
  }
  return url.href;
}

export function parseCaptionPreset(value) {
  if (!CAPTION_PRESET_NAMES.includes(value)) {
    throw new HttpError(400, `captionPreset must be one of ${CAPTION_PRESET_NAMES.join(", ")}`);
  }
  return value;
}

export function parseCaptionPosition(value) {
  if (!CAPTION_POSITION_NAMES.includes(value)) {
    throw new HttpError(400, `captionPosition must be one of ${CAPTION_POSITION_NAMES.join(", ")}`);
  }
  return value;
}

export function parseClipSeconds(value) {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_CLIP_SECONDS || seconds > MAX_CLIP_SECONDS) {
    throw new HttpError(400, `clipSeconds must be an integer from ${MIN_CLIP_SECONDS} to ${MAX_CLIP_SECONDS}`);
  }
  return seconds;
}

export function maxClipCount(durationSeconds, clipSeconds) {
  return Math.max(1, Math.min(MAX_CLIPS, Math.floor(durationSeconds / clipSeconds)));
}

// Auto (null) makes as many clips as the video allows. A chosen count is capped at that same maximum.
export function resolveClipCount(requested, durationSeconds, clipSeconds) {
  const max = maxClipCount(durationSeconds, clipSeconds);
  return requested === null ? max : Math.min(requested, max);
}

export function parseClipCount(value, durationSeconds, clipSeconds) {
  const count = Number(value);
  const max = maxClipCount(durationSeconds, clipSeconds);
  if (!Number.isInteger(count) || count < 1 || count > max) {
    throw new HttpError(400, `clipCount must be a whole number from 1 to ${max} for this video and clip length`);
  }
  return count;
}

export function combineScores(motion, audio) {
  const normalize = (values) => {
    const max = Math.max(...values, 0);
    return values.map((value) => (max > 0 ? value / max : 0));
  };
  const motionNormalized = normalize(motion);
  const audioNormalized = normalize(audio);
  return audioNormalized.map((loudness, second) => AUDIO_WEIGHT * loudness + MOTION_WEIGHT * motionNormalized[second]);
}

export function pickHighlights(scores, clipSeconds, clipCount) {
  const length = Math.min(clipSeconds, scores.length);
  const prefix = [0];
  for (const score of scores) prefix.push(prefix[prefix.length - 1] + score);

  const highlights = [];
  for (let index = 0; index < clipCount; index++) {
    const regionStart = Math.floor((index * scores.length) / clipCount);
    const regionEnd = Math.floor(((index + 1) * scores.length) / clipCount);
    if (regionEnd - regionStart < length) {
      throw new Error(`region ${index} is shorter than the ${length}s clip`);
    }
    let bestStart = regionStart;
    let bestScore = -Infinity;
    for (let start = regionStart; start + length <= regionEnd; start++) {
      const score = prefix[start + length] - prefix[start];
      if (score > bestScore) {
        bestScore = score;
        bestStart = start;
      }
    }
    // A video shorter than one clip is used whole, so there is no end to move.
    const end =
      length < clipSeconds ? bestStart + length : quietEnd(scores, bestStart, length, regionEnd, clipFlexSeconds(clipSeconds));
    highlights.push({ index, start: bestStart, length: end - bestStart });
  }
  return highlights;
}

const FLEX_RATIO = 0.25;

// How far a clip may run past the requested length to reach a quiet moment.
function clipFlexSeconds(clipSeconds) {
  return Math.round(clipSeconds * FLEX_RATIO);
}

// Extends the clip to the quietest second within flex seconds, so the cut lands in a pause.
// It never ends before the requested length, so the last words are kept.
// Among equally quiet ends, the one closest to the requested length wins.
function quietEnd(scores, start, length, regionEnd, flex) {
  const target = start + length;
  const latest = Math.min(target + flex, regionEnd);
  const candidates = [];
  for (let end = target; end <= latest; end++) candidates.push(end);
  candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));

  let bestEnd = target;
  let bestScore = Infinity;
  for (const end of candidates) {
    if (scores[end - 1] < bestScore) {
      bestScore = scores[end - 1];
      bestEnd = end;
    }
  }
  return bestEnd;
}

export function clipFileName(index) {
  return `clip-${String(index + 1).padStart(3, "0")}.mp4`;
}

export function parseProbeDuration(probe) {
  const seconds = Number(probe?.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("ffprobe found no usable duration");
  }
  return seconds;
}

const PROJECT_NAME_MAX = 120;

export function parseProjectName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > PROJECT_NAME_MAX) {
    throw new HttpError(400, `name must be 1 to ${PROJECT_NAME_MAX} characters`);
  }
  return name;
}

// A clip is named by the person, so keep the name plain enough to be a safe file name.
// YouTube takes titles up to 100 characters and descriptions up to 5000 bytes.
export const UPLOAD_TITLE_MAX = 100;
export const UPLOAD_DESCRIPTION_MAX_BYTES = 5000;

export function parseUploadTitle(value) {
  const title = typeof value === "string" ? value.trim() : "";
  if (title.length === 0 || title.length > UPLOAD_TITLE_MAX) {
    throw new HttpError(400, `title must be 1 to ${UPLOAD_TITLE_MAX} characters`);
  }
  return title;
}

export function parseUploadDescription(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > UPLOAD_DESCRIPTION_MAX_BYTES) {
    throw new HttpError(400, `description must be at most ${UPLOAD_DESCRIPTION_MAX_BYTES} bytes`);
  }
  return value;
}

export const CLIP_NAME_MAX = 60;

export function parseClipName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > CLIP_NAME_MAX) {
    throw new HttpError(400, `clip name must be 1 to ${CLIP_NAME_MAX} characters`);
  }
  return name;
}
