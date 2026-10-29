// A line takes the words that start within LINE_MS of its first word and ends early at a pause of PAUSE_MS, so each
// line is short enough to read at a glance and does not stay up through silence.
const LINE_MS = 1200;
const PAUSE_MS = 500;

// Groups the transcript's words into caption lines: { startMs, endMs, words }.
export function captionLines(words) {
  const lines = [];
  for (const word of words) {
    const line = lines.at(-1);
    if (line && word.startMs - line.startMs < LINE_MS && word.startMs - line.endMs < PAUSE_MS) {
      line.words.push(word);
      line.endMs = word.endMs;
    } else {
      lines.push({ startMs: word.startMs, endMs: word.endMs, words: [word] });
    }
  }
  return lines;
}

// The lines spoken during the clip, and their words, timed from the start of the clip.
export function captionsForClip(lines, clipStartMs, clipEndMs) {
  const inClip = (item) => item.endMs > clipStartMs && item.startMs < clipEndMs;
  const shift = (item) => ({
    ...item,
    startMs: Math.max(item.startMs, clipStartMs) - clipStartMs,
    endMs: Math.min(item.endMs, clipEndMs) - clipStartMs,
  });
  return lines.filter(inClip).map((line) => ({ ...shift(line), words: line.words.filter(inClip).map(shift) }));
}

// The stills that show a clip's lines: one per line, or word by word one per word with that word highlighted. A
// word's still stays up until the next word starts, so the line does not blink between its words.
export function captionStills(lines, wordByWord) {
  if (!wordByWord) {
    return lines.map((line) => ({
      words: line.words.map((word) => word.text),
      highlight: null,
      startMs: line.startMs,
      endMs: line.endMs,
    }));
  }
  return lines.flatMap((line) =>
    line.words
      .map((word, index) => ({
        words: line.words.map((lineWord) => lineWord.text),
        highlight: index,
        startMs: index === 0 ? line.startMs : word.startMs,
        endMs: index === line.words.length - 1 ? line.endMs : line.words[index + 1].startMs,
      }))
      .filter((still) => still.endMs > still.startMs),
  );
}
