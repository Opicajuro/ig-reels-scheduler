import { test } from "vitest";
import assert from "node:assert/strict";
import { UserError } from "../lib/user-error";
import {
  assertHttpUrl,
  clipFileName,
  combineScores,
  maxClipCount,
  parseClipCount,
  parseClipSeconds,
  parseUploadDescription,
  parseUploadTitle,
  parseProbeDuration,
  pickHighlights,
  resolveClipCount,
  sentenceBoundaries,
  snapToSentences,
  withSpeechDensity,
} from "./helpers.js";

test("resolveClipCount makes as many clips as the video allows for Auto, and caps a chosen count at that", () => {
  assert.equal(resolveClipCount(null, 100, 30), 3);
  assert.equal(resolveClipCount(null, 5, 30), 1);
  assert.equal(resolveClipCount(2, 100, 30), 2);
  assert.equal(resolveClipCount(9, 100, 30), 3);
});

test("pickHighlights returns one window per region, each at the best-scoring start, ties to the earliest", () => {
  const scores = [0, 0, 0, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 0, 0, 0, 0, 0];
  assert.deepEqual(pickHighlights(scores, 4, 2), [
    { index: 0, start: 1, length: 5 },
    { index: 1, start: 11, length: 5 },
  ]);
});

test("pickHighlights never overlaps clips and keeps them in time order", () => {
  const scores = Array.from({ length: 60 }, (_, second) => (second % 17) / 17);
  const highlights = pickHighlights(scores, 15, 4);
  for (let i = 1; i < highlights.length; i++) {
    assert.ok(highlights[i].start >= highlights[i - 1].start + 15);
  }
  assert.equal(highlights.length, 4);
});

test("pickHighlights uses the whole video when it is shorter than one clip", () => {
  const scores = [1, 2, 3, 4, 5];
  assert.deepEqual(pickHighlights(scores, 15, 1), [{ index: 0, start: 0, length: 5 }]);
});

test("pickHighlights throws when a region cannot hold a full clip", () => {
  assert.throws(() => pickHighlights(new Array(20).fill(1), 15, 2), /shorter than the 15s clip/);
});

test("combineScores weights loudness above motion and normalizes each signal", () => {
  const combined = combineScores([0, 10], [0, 5]);
  assert.deepEqual(combined, [0, 0.6 * 1 + 0.4 * 1]);
});

test("pickHighlights ends a clip on a quiet second, so the clip length varies", () => {
  const scores = [1, 1, 1, 1, 9, 9, 9, 9, 9, 9, 9, 9, 1, 1, 1, 1, 1, 1, 1, 1];
  assert.deepEqual(pickHighlights(scores, 8, 1), [{ index: 0, start: 4, length: 9 }]);
});

test("pickHighlights keeps each clip inside its part of the video and never shorter than the clip length", () => {
  const scores = Array.from({ length: 200 }, (_, second) => ((second * 37) % 11) / 10);
  const highlights = pickHighlights(scores, 40, 4);
  highlights.forEach((clip, index) => {
    const regionStart = Math.floor((index * 200) / 4);
    const regionEnd = Math.floor(((index + 1) * 200) / 4);
    assert.ok(clip.start >= regionStart, `clip ${index} starts before its part`);
    assert.ok(clip.start + clip.length <= regionEnd, `clip ${index} runs past its part`);
    assert.ok(clip.length >= 40 && clip.length <= 50, `clip ${index} length ${clip.length}`);
  });
});

test("pickHighlights never cuts a clip short to reach a quiet moment, so the end is not trimmed", () => {
  const scores = [1, 1, 1, 1, 9, 9, 9, 9, 9, 0, 9, 9, 9, 9, 1, 1, 1, 1, 1, 1];
  assert.deepEqual(pickHighlights(scores, 8, 1), [{ index: 0, start: 4, length: 8 }]);
});

test("combineScores returns zeros when a signal is silent or static", () => {
  assert.deepEqual(combineScores([0, 0], [0, 0]), [0, 0]);
});

test("maxClipCount fits as many clips as the video length allows", () => {
  assert.equal(maxClipCount(40, 15), 2);
  assert.equal(maxClipCount(5, 15), 1);
  assert.equal(maxClipCount(10000, 15), 10);
});

test("parseClipCount accepts whole numbers from 1 up to the maximum", () => {
  assert.equal(parseClipCount("1", 40, 15), 1);
  assert.equal(parseClipCount(2, 40, 15), 2);
});

test("parseClipCount rejects counts the video cannot fit, and values that are not whole numbers", () => {
  for (const value of [0, 3, 2.5, "many", undefined]) {
    assert.throws(
      () => parseClipCount(value, 40, 15),
      UserError,
    );
  }
  assert.throws(() => parseClipCount(3, 40, 15), /from 1 to 2/);
});

test("parseClipSeconds accepts whole numbers in range", () => {
  assert.equal(parseClipSeconds("15"), 15);
  assert.equal(parseClipSeconds(180), 180);
});

test("parseClipSeconds rejects values out of range or not whole", () => {
  for (const value of [14, 181, 30.5, "abc", undefined]) {
    assert.throws(() => parseClipSeconds(value), UserError);
  }
});

test("assertHttpUrl accepts http and https links", () => {
  assert.equal(assertHttpUrl("https://example.com/video.mp4"), "https://example.com/video.mp4");
  assert.equal(assertHttpUrl("http://example.com/a"), "http://example.com/a");
});

test("assertHttpUrl rejects other schemes and non-URLs", () => {
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "not a url", undefined]) {
    assert.throws(() => assertHttpUrl(value), UserError);
  }
});

test("clipFileName numbers clips from 001", () => {
  assert.equal(clipFileName(0), "clip-001.mp4");
  assert.equal(clipFileName(11), "clip-012.mp4");
});

test("parseProbeDuration reads the container duration", () => {
  assert.equal(parseProbeDuration({ format: { duration: "25.04" } }), 25.04);
});

test("parseProbeDuration throws when no duration is present", () => {
  assert.throws(() => parseProbeDuration({ format: {} }), /no usable duration/);
});

test("parseUploadTitle trims the title and enforces YouTube's 100-character limit", () => {
  assert.equal(parseUploadTitle("  Price check  "), "Price check");
  assert.throws(() => parseUploadTitle("   "), UserError);
  assert.throws(() => parseUploadTitle("x".repeat(101)), UserError);
  assert.equal(parseUploadTitle("x".repeat(100)), "x".repeat(100));
});

test("parseUploadDescription enforces YouTube's 5000-byte limit and keeps the text", () => {
  assert.equal(parseUploadDescription("Line one\n#shorts"), "Line one\n#shorts");
  assert.equal(parseUploadDescription(""), "");
  assert.throws(() => parseUploadDescription("é".repeat(2501)), UserError);
  assert.throws(() => parseUploadDescription(undefined), UserError);
});

test("pickHighlights never runs a clip past the longest clip to reach a quiet second", () => {
  const scores = new Array(300).fill(1);
  scores[220] = 0;
  const [highlight] = pickHighlights(scores, 180, 1);
  assert.equal(highlight.length, 180);
});

const spoken = (text, start, end) => ({ text, startMs: start * 1000, endMs: end * 1000 });

test("sentenceBoundaries ends sentences at final punctuation and at pauses of 0.6 s or more", () => {
  const words = [
    spoken("Hello", 1, 1.4),
    spoken("there.", 1.5, 2),
    spoken("This", 2.1, 2.3),
    spoken("is", 2.35, 2.5),
    spoken("it", 3.1, 3.3),
    spoken("really?", 3.4, 3.9),
    spoken("Yes", 3.95, 4.2),
  ];
  assert.deepEqual(sentenceBoundaries(words), { starts: [1000, 2100, 3100, 3950], ends: [2000, 2500, 3900, 4200] });
});

test("withSpeechDensity blends in the words per second, as a share of the busiest second", () => {
  const words = [spoken("a", 0.1, 0.2), spoken("b", 0.5, 0.6), spoken("c", 2.2, 2.4)];
  const blended = withSpeechDensity([1, 0, 0, 0.5], words);
  const expected = [0.7 + 0.3, 0, 0.3 * 0.5, 0.35];
  blended.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${value} is not ${expected[index]}`));
});

test("pickHighlights with words prefers the window where more is said", () => {
  const scores = new Array(40).fill(0.5);
  const words = Array.from({ length: 30 }, (_, index) => spoken(`w${index}`, 22 + index * 0.5, 22.4 + index * 0.5));
  words[29].text = "end.";
  const [highlight] = pickHighlights(scores, 15, 1, words);
  assert.ok(highlight.start >= 20 && highlight.start <= 22, `starts at ${highlight.start}`);
  assert.ok(highlight.start + highlight.length >= 36.5, `ends at ${highlight.start + highlight.length}`);
});

test("pickHighlights with words snaps both ends to the nearest sentence boundary within 5 s, on half seconds", () => {
  // Loud from 10 s to 25 s; sentences start at 8.3 s and 12.7 s and end at 26.2 s and 31 s.
  const scores = Array.from({ length: 60 }, (_, second) => (second >= 10 && second < 25 ? 1 : 0));
  const words = [
    spoken("Before.", 2, 2.5),
    spoken("First", 8.3, 8.8),
    spoken("bit.", 9, 9.5),
    spoken("Then", 12.7, 13),
    spoken("on", 13.1, 26.2),
    spoken("More", 27, 30),
    spoken("words", 30.2, 31),
  ];
  assert.deepEqual(pickHighlights(scores, 15, 1, words), [{ index: 0, start: 8, length: 18.5 }]);
});

test("pickHighlights with words leaves an edge with no boundary within 5 s where it was", () => {
  const scores = Array.from({ length: 60 }, (_, second) => (second >= 20 && second < 35 ? 1 : 0));
  const words = [spoken("Long", 2, 3), spoken("talk", 3.2, 36.2)];
  // Without a sentence start between 15 s and 25 s the start stays at 20 s; the end moves to 36.5 s.
  assert.deepEqual(pickHighlights(scores, 15, 1, words), [{ index: 0, start: 20, length: 16.5 }]);
});

test("snapToSentences keeps the length limits and the clip's part of the video", () => {
  const boundaries = { starts: [9000, 31000], ends: [20000, 46000] };
  // Snapping both ends would make a 11 s clip, under the 15 s minimum; the nearer valid pair wins.
  assert.deepEqual(snapToSentences(boundaries, 12, 27, 0, 30, 60), { start: 9, end: 27 });
  assert.deepEqual(snapToSentences(boundaries, 30, 45, 30, 60, 60), { start: 31, end: 46 });
  assert.deepEqual(snapToSentences(boundaries, 30, 45, 30, 45, 60), { start: 30, end: 45 });
});
