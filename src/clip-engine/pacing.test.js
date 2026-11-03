import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fillerIndexes, FPS, tightenClip, tightenedTime } from "./pacing.js";
import { CROSSFADE_SECONDS, overlayList, renderClip, tightenFilters } from "./ffmpeg.js";

const word = (text, start, end) => ({ text, startMs: start * 1000, endMs: end * 1000 });
const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected}`);

test("fillerIndexes cuts hesitations always, and like / you know only between pauses", () => {
  const words = [
    word("So,", 0, 0.3),
    word("um,", 0.35, 0.6),
    word("I", 0.65, 0.7),
    word("like", 0.75, 1),
    word("it.", 1.05, 1.3),
    word("Like", 1.8, 2),
    word("you", 2.5, 2.6),
    word("know", 2.6, 2.8),
    word("Uh-huh.", 3.2, 3.5),
    word("Erm", 4, 4.2),
  ];
  assert.deepEqual([...fillerIndexes(words)].sort((a, b) => a - b), [1, 5, 6, 7, 9]);
});

test("tightenClip shrinks a long pause to a quarter second, half on each side, on the frame grid", () => {
  const words = [word("one", 10.5, 11.2), word("two", 11.3, 12.5), word("three", 14.5, 15.2), word("four", 15.3, 16)];
  const { keep, length, words: tightened } = tightenClip(words, 10, 6.5);
  // The pause from 2.5 s to 4.5 s keeps 2.5 + 0.125 and 4.5 - 0.125, rounded to frames.
  assert.deepEqual(keep, [
    { start: 0, end: 79 / FPS },
    { start: 131 / FPS, end: 195 / FPS },
  ]);
  near(length, (79 + 64) / FPS);
  near(6.5 - length, 52 / FPS);
  assert.deepEqual(tightened.map((item) => item.text), ["one", "two", "three", "four"]);
  assert.equal(tightened[2].startMs, Math.round((4.5 - 52 / FPS) * 1000));
  assert.equal(tightened[0].startMs, 500);
});

test("tightenClip cuts fillers and trims silence at the clip's edges, and drops fillers from the words", () => {
  const words = [word("Well", 2, 2.4), word("um", 2.5, 2.9), word("yes.", 3, 3.4)];
  const { keep, length, words: tightened } = tightenClip(words, 0, 5);
  assert.deepEqual(keep, [
    { start: 53 / FPS, end: 75 / FPS },
    { start: 87 / FPS, end: 110 / FPS },
  ]);
  near(length, 45 / FPS);
  assert.deepEqual(tightened.map((item) => item.text), ["Well", "yes."]);
  assert.equal(tightened[0].startMs, Math.round((60 - 53) / FPS * 1000));
});

test("tightenClip keeps a clip with nothing said whole", () => {
  assert.deepEqual(tightenClip([word("far", 50, 51)], 0, 3), { keep: [{ start: 0, end: 3 }], length: 3, words: [] });
});

test("tightenedTime is monotonic, holds still across cuts and ends at the kept total", () => {
  const words = [word("a", 0.2, 0.6), word("b", 3, 3.5), word("um", 3.6, 4), word("c", 4.1, 4.6), word("d", 7, 7.4)];
  const { keep, length } = tightenClip(words, 0, 8);
  let previous = -1;
  for (let seconds = 0; seconds <= 8; seconds += 0.01) {
    const mapped = tightenedTime(keep, seconds);
    assert.ok(mapped >= previous - 1e-9, `${seconds}s maps back in time`);
    assert.ok(mapped <= seconds + 1e-9);
    previous = mapped;
  }
  near(tightenedTime(keep, 8), length);
  near(tightenedTime(keep, keep[1].start + 0.1), keep[0].end - keep[0].start + 0.1);
  near(tightenedTime(keep, (keep[0].end + keep[1].start) / 2), keep[0].end - keep[0].start);
});

test("tightenFilters selects whole frames and crossfades sound pieces that are each one crossfade longer", () => {
  const { video, audio } = tightenFilters([
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 4.5 },
  ]);
  assert.equal(video, `fps=30,select='between(n,0,29)+between(n,60,89)+between(n,120,134)',setpts=N/30/TB`);
  assert.equal(
    audio,
    [
      "[0:a]asplit=3[as0][as1][as2]",
      `[as0]atrim=start=0.000000:end=${(1 + CROSSFADE_SECONDS).toFixed(6)},asetpts=PTS-STARTPTS[at0]`,
      `[as1]atrim=start=2.000000:end=${(3 + CROSSFADE_SECONDS).toFixed(6)},asetpts=PTS-STARTPTS[at1]`,
      "[as2]atrim=start=4.000000:end=4.500000,asetpts=PTS-STARTPTS[at2]",
      "[at0][at1]acrossfade=d=0.02:c1=tri:c2=tri[ax1]",
      "[ax1][at2]acrossfade=d=0.02:c1=tri:c2=tri[aout]",
    ].join(";"),
  );
  assert.throws(() => tightenFilters([{ start: 0, end: 0.51 }]), /frame grid/);
  assert.throws(() => tightenFilters([{ start: 1, end: 2 }, { start: 0.5, end: 3 }]), /in order/);
});

function probeLength(file, stream) {
  return Number(
    execFileSync("ffprobe", [
      "-v", "error", "-select_streams", stream, "-show_entries", "stream=duration", "-of", "csv=p=0", file,
    ]).toString(),
  );
}

// Mean absolute level of the sound from seconds for length seconds.
function level(file, seconds, length) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-t", String(length), "-i", file, "-vn", "-ac", "1", "-ar", "8000",
    "-f", "s16le", "pipe:1",
  ]);
  let total = 0;
  for (let i = 0; i < raw.length; i += 2) total += Math.abs(raw.readInt16LE(i));
  return total / (raw.length / 2);
}

// The mean brightness of a 100×100 patch at x, y of the frame at seconds.
function patch(file, seconds, x, y) {
  const raw = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-vf", `crop=100:100:${x}:${y}`,
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ]);
  return raw.reduce((total, value) => total + value, 0) / raw.length;
}

test("a tightened render loses the long pause in picture and sound, and a caption lands at its mapped time", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacing-test-"));
  try {
    const source = path.join(dir, "source.mp4");
    // Speech (a tone) from 0.5 to 2.5 s and 4.5 to 6 s; the picture shows a white square while the third word is said.
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=gray:duration=8:size=1920x1080:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
      "-filter_complex",
      "[0:v]drawbox=x=910:y=490:w=100:h=100:color=white:t=fill:enable='between(t,4.5,5.2)'[v];" +
        "[1:a]volume='between(t,0.5,2.5)+between(t,4.5,6)':eval=frame[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
    ]);
    const words = [word("one", 0.5, 1.2), word("two", 1.3, 2.5), word("three", 4.5, 5.2), word("four", 5.3, 6)];
    const tightened = tightenClip(words, 0, 6.5);
    near(6.5 - tightened.length, 1.75, 0.03);

    // The third word's caption: a white still at its tightened time.
    const third = tightened.words[2];
    const still = path.join(dir, "still.png");
    const blank = path.join(dir, "blank.png");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=1080x1920,format=rgba", "-frames:v", "1", still]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black@0:s=1080x1920,format=rgba", "-frames:v", "1", blank]);
    const list = path.join(dir, "captions.ffconcat");
    writeFileSync(
      list,
      overlayList({
        overlays: [{ image: still, start: third.startMs / 1000, end: third.endMs / 1000 }],
        blank,
        length: tightened.length,
      }),
    );
    const output = path.join(dir, "clip.mp4");
    await renderClip({ input: source, output, start: 0, length: 6.5, overlay: list, tightened });

    near(probeLength(output, "v:0"), tightened.length, 0.04);
    near(probeLength(output, "a:0"), tightened.length, 0.04);
    const mapped = third.startMs / 1000;
    near(mapped, 4.5 - 52 / FPS, 0.001);
    // The caption covers the whole frame; the source's square is under it, so the caption shows from mapped on.
    assert.ok(patch(output, mapped - 0.1, 0, 0) < 160, "the caption shows before its word");
    assert.ok(patch(output, mapped + 0.1, 0, 0) > 240, "the caption is missing during its word");
    assert.ok(level(output, 1, 1) > 1000, "the first words lost their sound");
    assert.ok(level(output, mapped - 0.2, 0.15) < 100, "the shortened pause is not silent");
    assert.ok(level(output, mapped + 0.05, 0.5) > 1000, "the third word's sound is not at its mapped time");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tightened render shows the source picture at the mapped time", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pacing-picture-test-"));
  try {
    const source = path.join(dir, "source.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=gray:duration=8:size=1920x1080:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=8",
      "-filter_complex", "[0:v]drawbox=x=0:y=0:w=1920:h=1080:color=white:t=fill:enable='gte(t,4.5)'[v]",
      "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
    ]);
    const words = [word("one", 0.5, 1.2), word("two", 1.3, 2.5), word("three", 4.5, 5.2), word("four", 5.3, 6)];
    const tightened = tightenClip(words, 0, 6.5);
    const output = path.join(dir, "clip.mp4");
    await renderClip({ input: source, output, start: 0, length: 6.5, overlay: null, tightened });
    const mapped = tightened.words[2].startMs / 1000;
    assert.ok(patch(output, mapped - 0.1, 490, 910) < 160, "the picture after the pause comes early");
    assert.ok(patch(output, mapped + 0.1, 490, 910) > 240, "the picture after the pause comes late");
    near(probeLength(output, "a:0"), tightened.length, 0.04);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
