import { describe, expect, it } from "vitest";
import { captionLines, captionsForClip } from "@/clip-engine/captions-timing.js";
import {
  checkEditedWords,
  clipLines,
  clipWords,
  deleteWord,
  mergeWithNextLine,
  parseClipWords,
  setWordText,
  splitAtWord,
  type ClipWord,
} from "./caption-words";

// Two lines: "so um this" and, after a pause, "is good".
const words: ClipWord[] = [
  { text: "so", startMs: 0, endMs: 200, lineStart: true },
  { text: "um", startMs: 200, endMs: 400 },
  { text: "this", startMs: 400, endMs: 700 },
  { text: "is", startMs: 1500, endMs: 1700, lineStart: true },
  { text: "good", startMs: 1700, endMs: 2000 },
];

const texts = (list: ClipWord[]) => clipLines(list).map((line) => line.words.map((word) => word.text).join(" "));

describe("clipWords", () => {
  const transcript = [
    { text: "before", startMs: 9000, endMs: 9400 },
    { text: "hello", startMs: 10200, endMs: 10600 },
    { text: "there", startMs: 10600, endMs: 11000 },
    { text: "friend", startMs: 11800, endMs: 12200 },
    { text: "after", startMs: 15500, endMs: 16000 },
  ];

  it("slices the transcript to the clip, timed from its start, in the lines the render draws", () => {
    const sliced = clipWords(transcript, 10, 5);
    expect(sliced).toEqual([
      { text: "hello", startMs: 200, endMs: 600, lineStart: true },
      { text: "there", startMs: 600, endMs: 1000 },
      { text: "friend", startMs: 1800, endMs: 2200, lineStart: true },
    ]);
    const rendered = captionsForClip(captionLines(transcript), 10000, 15000);
    expect(clipLines(sliced).map((line) => line.words.map((word) => word.text))).toEqual(
      rendered.map((line: { words: { text: string }[] }) => line.words.map((word) => word.text)),
    );
  });

  it("clamps a word cut by the clip's edges", () => {
    expect(clipWords(transcript, 10.4, 1.5)).toEqual([
      { text: "hello", startMs: 0, endMs: 200, lineStart: true },
      { text: "there", startMs: 200, endMs: 600 },
      { text: "friend", startMs: 1400, endMs: 1500, lineStart: true },
    ]);
  });

  it("has no words for a silent clip", () => {
    expect(clipWords(transcript, 13, 2)).toEqual([]);
  });
});

describe("word edits", () => {
  it("groups the words into lines from each line start", () => {
    expect(clipLines(words).map(({ startMs, endMs, first }) => ({ startMs, endMs, first }))).toEqual([
      { startMs: 0, endMs: 700, first: 0 },
      { startMs: 1500, endMs: 2000, first: 3 },
    ]);
  });

  it("changes a word's text and nothing else", () => {
    const edited = setWordText(words, 2, "that");
    expect(texts(edited)).toEqual(["so um that", "is good"]);
    expect(edited[2]).toEqual({ text: "that", startMs: 400, endMs: 700 });
    expect(words[2].text).toBe("this");
  });

  it("merges a line with the next one", () => {
    expect(texts(mergeWithNextLine(words, 0))).toEqual(["so um this is good"]);
    expect(() => mergeWithNextLine(words, 1)).toThrow("no line after it");
  });

  it("splits a line at a word", () => {
    expect(texts(splitAtWord(words, 2))).toEqual(["so um", "this", "is good"]);
    expect(() => splitAtWord(words, 3)).toThrow("already starts a line");
    expect(() => splitAtWord(words, 9)).toThrow("no word 10");
  });

  it("deletes a word, the next word starting the line when it was the first", () => {
    expect(texts(deleteWord(words, 1))).toEqual(["so this", "is good"]);
    const firstGone = deleteWord(words, 0);
    expect(texts(firstGone)).toEqual(["um this", "is good"]);
    expect(firstGone[0].lineStart).toBe(true);
    // The last word of a one-word line goes with its line.
    expect(texts(deleteWord(deleteWord(words, 4), 3))).toEqual(["so um this"]);
  });
});

describe("parseClipWords and checkEditedWords", () => {
  it("refuses malformed stored words", () => {
    expect(() => parseClipWords({})).toThrow("not a list");
    expect(() => parseClipWords([{ text: "a", startMs: 0, endMs: 1 }])).toThrow("does not start a line");
    expect(() => parseClipWords([{ text: "a", startMs: 5, endMs: 1, lineStart: true }])).toThrow("word 1 is malformed");
    expect(parseClipWords(words)).toEqual(words);
  });

  it("takes edited texts, line breaks and deletions, trimmed", () => {
    const edited = splitAtWord(deleteWord(setWordText(words, 2, " that "), 1), 1);
    expect(checkEditedWords(words, edited)).toEqual([
      { text: "so", startMs: 0, endMs: 200, lineStart: true },
      { text: "that", startMs: 400, endMs: 700, lineStart: true },
      { text: "is", startMs: 1500, endMs: 1700, lineStart: true },
      { text: "good", startMs: 1700, endMs: 2000 },
    ]);
  });

  it("refuses empty words, changed times and reordered words", () => {
    expect(() => checkEditedWords(words, setWordText(words, 0, "  "))).toThrow("cannot be empty");
    expect(() => checkEditedWords(words, setWordText(words, 0, "x".repeat(41)))).toThrow("at most 40");
    const moved = words.map((word, index) => (index === 1 ? { ...word, startMs: 250 } : word));
    expect(() => checkEditedWords(words, moved)).toThrow("do not match");
    const swapped = [words[0], words[2], { ...words[1] }, ...words.slice(3)];
    expect(() => checkEditedWords(words, swapped)).toThrow("do not match");
  });
});
