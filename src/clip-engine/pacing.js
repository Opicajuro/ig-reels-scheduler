// "Tighten pacing": inside a clip, pauses longer than LONG_PAUSE_SECONDS shrink to KEPT_PAUSE_SECONDS and lone filler
// words are cut. The cuts come from whisper's word times and are made on the 30 fps frame grid, so the picture and
// the sound lose exactly the same time. One mapping, tightenedTime, moves a time in the clip to where it lands once
// tightened; captions, the progress bar and the end card all use it.

export const FPS = 30;
export const LONG_PAUSE_SECONDS = 0.7;
export const KEPT_PAUSE_SECONDS = 0.25;
// The pause on both sides that makes a soft filler ("like", "you know") a filler rather than part of a sentence.
export const SOFT_FILLER_PAUSE_SECONDS = 0.3;
// Cuts and kept pieces shorter than this are not worth a jump cut.
const MIN_FRAMES = 2;

// Hesitation sounds, always cut. "uh-huh" and "mm-hmm" are answers, not hesitations, so they stay.
export const FILLER_WORDS = ["um", "umm", "uh", "uhh", "erm"];
// Cut only when spoken alone, with a pause before and after.
export const SOFT_FILLERS = [["like"], ["you", "know"]];

const plain = (text) => text.toLowerCase().replace(/[^a-z]/g, "");

// The indexes of the words that are cut as fillers.
export function fillerIndexes(words) {
  const cut = new Set();
  const pauseBefore = (index) => index === 0 || words[index].startMs - words[index - 1].endMs >= SOFT_FILLER_PAUSE_SECONDS * 1000;
  const pauseAfter = (index) =>
    index === words.length - 1 || words[index + 1].startMs - words[index].endMs >= SOFT_FILLER_PAUSE_SECONDS * 1000;
  words.forEach((word, index) => {
    if (FILLER_WORDS.includes(plain(word.text))) cut.add(index);
    for (const phrase of SOFT_FILLERS) {
      const last = index + phrase.length - 1;
      if (last >= words.length) continue;
      if (!phrase.every((part, offset) => plain(words[index + offset].text) === part)) continue;
      if (!pauseBefore(index) || !pauseAfter(last)) continue;
      for (let at = index; at <= last; at++) cut.add(at);
    }
  });
  return cut;
}

// What a clip keeps once tightened: { keep, length, words }. keep lists the kept pieces as { start, end } seconds from
// the clip's start, on the frame grid and in order; length is their total, the tightened clip's length; words are the
// clip's words without the fillers, as { text, startMs, endMs } in tightened time. start and length are the clip's
// place in the source, in seconds; words is the whole transcript.
export function tightenClip(words, start, length) {
  if (!(length > 0)) throw new Error(`a ${length}s clip cannot be tightened`);
  const frames = Math.round(length * FPS);
  const clipMs = { from: start * 1000, to: (start + length) * 1000 };
  const fillers = fillerIndexes(words);
  const inClip = [];
  words.forEach((word, index) => {
    if (word.endMs <= clipMs.from || word.startMs >= clipMs.to) return;
    inClip.push({
      word,
      filler: fillers.has(index),
      start: Math.max(word.startMs - clipMs.from, 0) / 1000,
      end: Math.min(word.endMs - clipMs.from, length * 1000) / 1000,
    });
  });
  const spoken = inClip.filter((item) => !item.filler);
  if (spoken.length === 0) {
    return { keep: [{ start: 0, end: frames / FPS }], length: frames / FPS, words: [] };
  }

  // The stretches to cut, in seconds: every filler, and the middle of every long pause, keeping KEPT_PAUSE_SECONDS of
  // it (half on each side between words, all of it next to the word at the clip's start and end).
  const cuts = inClip.filter((item) => item.filler).map((item) => [item.start, item.end]);
  const half = KEPT_PAUSE_SECONDS / 2;
  if (spoken[0].start > LONG_PAUSE_SECONDS) cuts.push([0, spoken[0].start - KEPT_PAUSE_SECONDS]);
  let spokenEnd = spoken[0].end;
  for (const item of spoken.slice(1)) {
    if (item.start - spokenEnd > LONG_PAUSE_SECONDS) cuts.push([spokenEnd + half, item.start - half]);
    spokenEnd = Math.max(spokenEnd, item.end);
  }
  if (length - spokenEnd > LONG_PAUSE_SECONDS) cuts.push([spokenEnd + KEPT_PAUSE_SECONDS, length]);

  // On the frame grid: a frame is cut when any cut covers it, then short cuts and short kept pieces are dropped.
  const cutFrame = new Array(frames).fill(false);
  for (const [from, to] of cuts) {
    for (let frame = Math.round(from * FPS); frame < Math.min(Math.round(to * FPS), frames); frame++) cutFrame[frame] = true;
  }
  const runs = [];
  for (let frame = 0; frame < frames; frame++) {
    const last = runs.at(-1);
    if (last && last.cut === cutFrame[frame]) last.end = frame + 1;
    else runs.push({ cut: cutFrame[frame], start: frame, end: frame + 1 });
  }
  for (const run of runs) if (run.cut && run.end - run.start < MIN_FRAMES) run.cut = false;
  for (const run of runs) if (!run.cut && run.end - run.start < MIN_FRAMES && runs.length > 1) run.cut = true;
  const keep = [];
  for (const run of runs) {
    if (run.cut) continue;
    const last = keep.at(-1);
    if (last && last.end === run.start) last.end = run.end;
    else keep.push({ start: run.start, end: run.end });
  }
  if (keep.length === 0) throw new Error(`tightening the ${length}s clip at ${start}s would cut all of it`);
  const keepSeconds = keep.map((piece) => ({ start: piece.start / FPS, end: piece.end / FPS }));
  const keptFrames = keep.reduce((total, piece) => total + piece.end - piece.start, 0);

  const tightenedWords = spoken
    .map(({ word, start: from, end: to }) => ({
      text: word.text,
      startMs: Math.round(tightenedTime(keepSeconds, from) * 1000),
      endMs: Math.round(tightenedTime(keepSeconds, to) * 1000),
    }))
    .filter((word) => word.endMs > word.startMs);
  return { keep: keepSeconds, length: keptFrames / FPS, words: tightenedWords };
}

// Where seconds from the clip's start land in the tightened clip. A time inside a cut lands where the cut is.
export function tightenedTime(keep, seconds) {
  let before = 0;
  for (const piece of keep) {
    if (seconds <= piece.start) return before;
    if (seconds < piece.end) return before + seconds - piece.start;
    before += piece.end - piece.start;
  }
  return before;
}
