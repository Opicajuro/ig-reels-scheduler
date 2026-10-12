import { test } from "vitest";
import assert from "node:assert/strict";
import {
  assertHttpUrl,
  clipFileName,
  combineScores,
  HttpError,
  maxClipCount,
  parseClipCount,
  parseClipSeconds,
  parseUploadDescription,
  parseUploadTitle,
  parseProbeDuration,
  pickHighlights,
  resolveClipCount,
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
      (err) => err instanceof HttpError && err.status === 400,
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
    assert.throws(() => parseClipSeconds(value), HttpError);
  }
});

test("assertHttpUrl accepts http and https links", () => {
  assert.equal(assertHttpUrl("https://example.com/video.mp4"), "https://example.com/video.mp4");
  assert.equal(assertHttpUrl("http://example.com/a"), "http://example.com/a");
});

test("assertHttpUrl rejects other schemes and non-URLs", () => {
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "not a url", undefined]) {
    assert.throws(() => assertHttpUrl(value), HttpError);
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
  assert.throws(() => parseUploadTitle("   "), (err) => err.status === 400);
  assert.throws(() => parseUploadTitle("x".repeat(101)), (err) => err.status === 400);
  assert.equal(parseUploadTitle("x".repeat(100)), "x".repeat(100));
});

test("parseUploadDescription enforces YouTube's 5000-byte limit and keeps the text", () => {
  assert.equal(parseUploadDescription("Line one\n#shorts"), "Line one\n#shorts");
  assert.equal(parseUploadDescription(""), "");
  assert.throws(() => parseUploadDescription("é".repeat(2501)), (err) => err.status === 400);
  assert.throws(() => parseUploadDescription(undefined), (err) => err.status === 400);
});
