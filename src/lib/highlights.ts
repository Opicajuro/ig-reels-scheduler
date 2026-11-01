import { MAX_CLIP_SECONDS, MAX_CLIPS, MIN_CLIP_SECONDS } from "@/clip-engine/helpers.js";
import { UserError } from "./user-error";

// The highlights of a project on the review timeline, in seconds of the source video. The project page's timeline and
// the server share these, so the server takes exactly what the timeline allows.

export type Highlight = { start: number; length: number };
export type LengthLimits = { min: number; max: number };
export type Word = { text: string; startMs: number; endMs: number };

// Highlights start and end on half seconds: the arrow keys move them by one step, and dragging snaps to it.
export const HIGHLIGHT_STEP = 0.5;

// As long as the clip length setting allows, or the whole video when it is shorter than the shortest clip.
export function lengthLimits(durationSeconds: number): LengthLimits {
  return { min: Math.min(MIN_CLIP_SECONDS, durationSeconds), max: Math.min(MAX_CLIP_SECONDS, durationSeconds) };
}

const onStep = (seconds: number) => Number.isInteger(seconds / HIGHLIGHT_STEP);

// The highlights in time order, or a UserError naming the first one that does not fit the video or overlaps another.
export function validateHighlights(value: unknown, durationSeconds: number): Highlight[] {
  if (!Array.isArray(value)) throw new UserError("the highlights must be a list");
  if (value.length === 0) throw new UserError("add at least one highlight");
  if (value.length > MAX_CLIPS) throw new UserError(`at most ${MAX_CLIPS} highlights`);
  const { min, max } = lengthLimits(durationSeconds);
  const highlights = value.map((item: unknown, index): Highlight => {
    const { start, length } = (item ?? {}) as Record<string, unknown>;
    if (typeof start !== "number" || typeof length !== "number" || !onStep(start) || !onStep(length)) {
      throw new UserError(`highlight ${index + 1} must start and last a whole number of half seconds`);
    }
    if (start < 0 || start + length > durationSeconds) {
      throw new UserError(`highlight ${index + 1} must lie within the ${durationSeconds}s video`);
    }
    if (length < min || length > max) {
      throw new UserError(`highlight ${index + 1} must be ${min} to ${max} seconds long`);
    }
    return { start, length };
  });
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    if (sorted[index].start < previous.start + previous.length) {
      throw new UserError(`the highlights at ${formatTime(previous.start)} and ${formatTime(sorted[index].start)} overlap`);
    }
  }
  return sorted;
}

// The highlights the timeline sends with "Make clips", as JSON.
export function parseHighlightsJson(text: string, durationSeconds: number): Highlight[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UserError("the highlights are not valid JSON");
  }
  return validateHighlights(value, durationSeconds);
}

export function parseTranscript(value: unknown): Word[] {
  const valid =
    Array.isArray(value) &&
    value.every((word: unknown) => {
      const { text, startMs, endMs } = (word ?? {}) as Record<string, unknown>;
      return typeof text === "string" && typeof startMs === "number" && typeof endMs === "number";
    });
  if (!valid) throw new Error("the stored transcript is malformed");
  return value as Word[];
}

// What is said during a highlight: every word that starts in it.
export function wordsInRange(words: Word[], { start, length }: Highlight): string {
  const from = start * 1000;
  const to = (start + length) * 1000;
  return words
    .filter((word) => word.startMs >= from && word.startMs < to)
    .map((word) => word.text)
    .join(" ");
}

// 65.5 → "1:05.5", 3600 → "1:00:00".
export function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = `${String(whole % 60).padStart(2, "0")}${seconds % 1 === 0 ? "" : `.${Math.round((seconds % 1) * 10)}`}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// The timeline's math: it is width pixels wide for the whole video.

export function secondsToPx(seconds: number, durationSeconds: number, width: number): number {
  return (seconds / durationSeconds) * width;
}

export function pxToSeconds(px: number, durationSeconds: number, width: number): number {
  if (width <= 0) throw new Error("the timeline has no width");
  return (px / width) * durationSeconds;
}

export function snap(seconds: number): number {
  return Math.round(seconds / HIGHLIGHT_STEP) * HIGHLIGHT_STEP;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

// The free stretch around highlight index: from the end of the one before (or 0) to the start of the one after (or the
// video's end).
function room(highlights: Highlight[], index: number, durationSeconds: number) {
  const before = highlights[index - 1];
  const after = highlights[index + 1];
  return { from: before ? before.start + before.length : 0, to: after ? after.start : durationSeconds };
}

function replace(highlights: Highlight[], index: number, highlight: Highlight): Highlight[] {
  return highlights.map((item, at) => (at === index ? highlight : item));
}

// Moves the highlight to start as near start as it can without overlapping its neighbours or leaving the video.
export function moveHighlight(highlights: Highlight[], index: number, start: number, durationSeconds: number): Highlight[] {
  const { length } = highlights[index];
  const { from, to } = room(highlights, index, durationSeconds);
  return replace(highlights, index, { start: clamp(snap(start), from, to - length), length });
}

// Moves one edge of the highlight to seconds, as near as its length limits and its neighbours allow. The other edge
// stays.
export function resizeHighlight(
  highlights: Highlight[],
  index: number,
  edge: "start" | "end",
  seconds: number,
  durationSeconds: number,
  limits: LengthLimits,
): Highlight[] {
  const { start, length } = highlights[index];
  const end = start + length;
  const { from, to } = room(highlights, index, durationSeconds);
  if (edge === "end") {
    const newEnd = clamp(snap(seconds), start + limits.min, Math.min(start + limits.max, to));
    return replace(highlights, index, { start, length: newEnd - start });
  }
  const newStart = clamp(snap(seconds), Math.max(from, end - limits.max), end - limits.min);
  return replace(highlights, index, { start: newStart, length: end - newStart });
}

// A new highlight of up to length seconds starting at the playhead, moved back when the gap it is in ends too soon.
// Null when the playhead is on a highlight, there are as many as allowed, or the gap is shorter than the shortest clip.
export function addHighlight(
  highlights: Highlight[],
  at: number,
  length: number,
  durationSeconds: number,
  limits: LengthLimits,
): Highlight[] | null {
  if (highlights.length >= MAX_CLIPS) return null;
  const start = Math.floor(clamp(at, 0, durationSeconds) / HIGHLIGHT_STEP) * HIGHLIGHT_STEP;
  if (highlights.some((item) => start >= item.start && start < item.start + item.length)) return null;
  const index = highlights.filter((item) => item.start < start).length;
  const before = highlights[index - 1];
  const from = before ? before.start + before.length : 0;
  const to = highlights[index]?.start ?? durationSeconds;
  const fitted = Math.min(snap(length), limits.max, to - from);
  if (fitted < limits.min) return null;
  const added = { start: Math.min(start, to - fitted), length: fitted };
  return [...highlights.slice(0, index), added, ...highlights.slice(index)];
}

export function removeHighlight(highlights: Highlight[], index: number): Highlight[] {
  return highlights.filter((_, at) => at !== index);
}
