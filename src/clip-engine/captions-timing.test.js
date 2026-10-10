import { test } from "vitest";
import assert from "node:assert/strict";
import { captionsForClip } from "./captions-timing.js";

const caption = (text, startMs, endMs) => ({ text, startMs, endMs, timestampMs: startMs, confidence: 1 });

test("captionsForClip shifts timing so the clip starts at zero", () => {
  const result = captionsForClip([caption("hello", 31000, 32000)], 30000, 45000);
  assert.deepEqual(result, [caption("hello", 1000, 2000)]);
});

test("captionsForClip drops captions outside the clip", () => {
  const result = captionsForClip(
    [caption("before", 1000, 2000), caption("inside", 31000, 32000), caption("after", 50000, 51000)],
    30000,
    45000,
  );
  assert.deepEqual(result.map((c) => c.text), ["inside"]);
});

test("captionsForClip trims captions that cross the clip edges", () => {
  const result = captionsForClip([caption("edge", 29000, 31000), caption("tail", 44000, 46000)], 30000, 45000);
  assert.deepEqual(result, [
    caption("edge", 0, 1000),
    caption("tail", 14000, 15000),
  ]);
});
