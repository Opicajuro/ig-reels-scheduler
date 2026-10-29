import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { captionLines, captionsForClip, captionStills } from "./captions-timing.js";
import { overlayList } from "./ffmpeg.js";
import { wordsFromWhisperJson } from "./transcribe.js";

const word = (text, startMs, endMs) => ({ text, startMs, endMs });
const line = (words) => ({ startMs: words[0].startMs, endMs: words.at(-1).endMs, words });
const jfkWords = () =>
  wordsFromWhisperJson(JSON.parse(readFileSync(new URL("./whisper-words.fixture.json", import.meta.url), "utf8")));

test("captionLines groups the words that start within 1.2 s of a line's first word", () => {
  const lines = captionLines(jfkWords());
  assert.deepEqual(
    lines.map((l) => [l.words.map((w) => w.text).join(" "), l.startMs, l.endMs]),
    [
      ["And so my fellow", 320, 1590],
      ["Americans,", 1590, 3300],
      ["ask not", 3300, 4990],
      ["what your country", 4990, 6260],
      ["can do for you,", 6260, 8190],
      ["ask what you can do", 8190, 9440],
      ["for your country.", 9440, 10510],
    ],
  );
});

test("captionLines starts a new line after a pause", () => {
  const lines = captionLines([word("one", 0, 200), word("two", 800, 1000)]);
  assert.deepEqual(lines.map((l) => l.words.length), [1, 1]);
});

test("captionsForClip shifts lines and words so the clip starts at zero", () => {
  const result = captionsForClip([line([word("hello", 31000, 31500), word("there", 31500, 32000)])], 30000, 45000);
  assert.deepEqual(result, [line([word("hello", 1000, 1500), word("there", 1500, 2000)])]);
});

test("captionsForClip drops lines outside the clip and words that cross out of it", () => {
  const result = captionsForClip(
    [
      line([word("before", 1000, 2000)]),
      line([word("edge", 29000, 29800), word("in", 29800, 31000)]),
      line([word("tail", 44000, 44800), word("out", 45200, 46000)]),
      line([word("after", 50000, 51000)]),
    ],
    30000,
    45000,
  );
  assert.deepEqual(result, [
    { startMs: 0, endMs: 1000, words: [word("in", 0, 1000)] },
    { startMs: 14000, endMs: 15000, words: [word("tail", 14000, 14800)] },
  ]);
});

test("captionStills shows one still per line", () => {
  const stills = captionStills([line([word("hi", 0, 400), word("you", 400, 900)])], false);
  assert.deepEqual(stills, [{ words: ["hi", "you"], highlight: null, startMs: 0, endMs: 900 }]);
});

test("captionStills word by word highlights each word until the next one starts", () => {
  const stills = captionStills(
    [line([word("hi", 100, 300), word("there", 450, 900)]), line([word("bye", 1500, 1800)])],
    true,
  );
  assert.deepEqual(stills, [
    { words: ["hi", "there"], highlight: 0, startMs: 100, endMs: 450 },
    { words: ["hi", "there"], highlight: 1, startMs: 450, endMs: 900 },
    { words: ["bye"], highlight: 0, startMs: 1500, endMs: 1800 },
  ]);
});

test("word-by-word stills of a clip make an overlay list with no overlaps and blanks in the gaps", () => {
  const lines = captionsForClip(captionLines(jfkWords()), 1000, 7000);
  const stills = captionStills(lines, true);
  assert.equal(stills.length, 10);
  for (const [index, still] of stills.entries()) {
    assert.ok(still.endMs > still.startMs);
    if (index > 0) assert.ok(still.startMs >= stills[index - 1].endMs, `still ${index} overlaps the one before it`);
  }
  const overlays = stills.map((still, index) => ({
    image: `w${index}.png`,
    start: still.startMs / 1000,
    end: still.endMs / 1000,
  }));
  const list = overlayList({ overlays, blank: "blank.png", length: 6 });
  // The clip starts inside "fellow", so the first still shows from 0; "for" is cut at the clip's end, and "you," after
  // it is left out.
  assert.match(list, /^ffconcat version 1\.0\nfile 'w0\.png'\noption framerate 1000\nduration 0\.590\n/);
  assert.match(list, /file 'w9\.png'\noption framerate 1000\nduration 0\.160\n/);
});
