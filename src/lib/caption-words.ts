import { captionLines, captionsForClip } from "@/clip-engine/captions-timing.js";
import type { Word } from "./highlights";
import { UserError } from "./user-error";

// A clip's own caption words (Clip.words), timed in ms from the clip's start. lineStart marks the first word of each
// caption line, so the lines drawn are the ones edited in the clip's Captions tab.
export type ClipWord = { text: string; startMs: number; endMs: number; lineStart?: true };
export type ClipLine = { startMs: number; endMs: number; words: ClipWord[]; first: number };

export const WORD_MAX = 40;

// The words a clip is captioned with, from the project's transcript, grouped into the lines the render draws.
export function clipWords(transcript: Word[], start: number, length: number): ClipWord[] {
  const lines: { words: Word[] }[] = captionsForClip(captionLines(transcript), start * 1000, (start + length) * 1000);
  return lines.flatMap((line) =>
    line.words.map(({ text, startMs, endMs }, index) => ({ text, startMs, endMs, ...(index === 0 ? { lineStart: true as const } : {}) })),
  );
}

export function parseClipWords(value: unknown): ClipWord[] {
  if (!Array.isArray(value)) throw new Error("the clip's words are not a list");
  return value.map((word: unknown, index) => {
    const { text, startMs, endMs, lineStart } = (word ?? {}) as Record<string, unknown>;
    if (typeof text !== "string" || typeof startMs !== "number" || typeof endMs !== "number" || endMs < startMs) {
      throw new Error(`the clip's word ${index + 1} is malformed`);
    }
    if (lineStart !== undefined && lineStart !== true) throw new Error(`the clip's word ${index + 1} has a malformed line start`);
    if (index === 0 && !lineStart) throw new Error("the clip's first word does not start a line");
    return { text, startMs, endMs, ...(lineStart ? { lineStart } : {}) };
  });
}

// The caption lines of a clip's words, each timed from its first word to its last, with its first word's index.
export function clipLines(words: ClipWord[]): ClipLine[] {
  const lines: ClipLine[] = [];
  words.forEach((word, index) => {
    const line = lines.at(-1);
    if (word.lineStart || !line) {
      if (!word.lineStart) throw new Error("the clip's first word does not start a line");
      lines.push({ startMs: word.startMs, endMs: word.endMs, words: [word], first: index });
    } else {
      line.words.push(word);
      line.endMs = word.endMs;
    }
  });
  return lines;
}

function wordAt(words: ClipWord[], index: number): ClipWord {
  const word = words[index];
  if (!word) throw new Error(`there is no word ${index + 1}`);
  return word;
}

export function setWordText(words: ClipWord[], index: number, text: string): ClipWord[] {
  wordAt(words, index);
  return words.map((word, at) => (at === index ? { ...word, text } : word));
}

// Joins the line that starts with the word after line lineIndex's last word onto it.
export function mergeWithNextLine(words: ClipWord[], lineIndex: number): ClipWord[] {
  const next = clipLines(words)[lineIndex + 1];
  if (!next) throw new Error(`caption line ${lineIndex + 1} has no line after it`);
  return words.map((word, at) => (at === next.first ? { text: word.text, startMs: word.startMs, endMs: word.endMs } : word));
}

// Starts a new line at the word.
export function splitAtWord(words: ClipWord[], index: number): ClipWord[] {
  if (wordAt(words, index).lineStart) throw new Error(`word ${index + 1} already starts a line`);
  return words.map((word, at) => (at === index ? { ...word, lineStart: true as const } : word));
}

// Removes the word. The word after it starts the line instead, when it was the line's first.
export function deleteWord(words: ClipWord[], index: number): ClipWord[] {
  const removed = wordAt(words, index);
  const rest = words.filter((_, at) => at !== index);
  const after = rest[index];
  if (removed.lineStart && after && !after.lineStart) rest[index] = { ...after, lineStart: true };
  return rest;
}

// Checks the words sent from the Captions tab against the clip's words: only the texts, the line breaks and which words
// are left may change, never the times.
export function checkEditedWords(current: ClipWord[], value: unknown): ClipWord[] {
  const edited = parseClipWords(value);
  let from = 0;
  for (const word of edited) {
    const text = word.text.trim();
    if (!text) throw new UserError("a caption word cannot be empty: delete it instead");
    if (text.length > WORD_MAX) throw new UserError(`a caption word can be at most ${WORD_MAX} characters`);
    while (from < current.length && (current[from].startMs !== word.startMs || current[from].endMs !== word.endMs)) from++;
    if (from === current.length) throw new Error("the edited words do not match the clip's words");
    from++;
    word.text = text;
  }
  return edited;
}
