import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captionLines, captionStills } from "./captions-timing.js";
import { transcribeToWords, wordsFromWhisperJson } from "./transcribe.js";

// whisper-cli's -ml 1 -sow -oj output for whisper.cpp's samples/jfk.wav. The layout is the one whisper-cli 1.9.5
// writes; the words and times are the ones its README lists for -ml 1, with punctuation joined to its word as -sow does.
const FIXTURE = fileURLToPath(new URL("./whisper-words.fixture.json", import.meta.url));

test("transcribeToWords runs whisper-cli in English without voice detection and returns its words", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "transcribe-test-"));
  const media = path.join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    media,
  ]);

  // Records its arguments, one per line, and writes the fixture where -of says.
  const fakeWhisper = path.join(dir, "fake-whisper.sh");
  const argsFile = path.join(dir, "args.txt");
  writeFileSync(
    fakeWhisper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${argsFile}'`,
      "prefix=",
      "while [ $# -gt 0 ]; do",
      '  case "$1" in -of) prefix="$2"; shift;; esac',
      "  shift",
      "done",
      `cp '${FIXTURE}' "$prefix.json"`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeWhisper, 0o755);

  const words = await transcribeToWords({
    mediaPath: media,
    workDir: dir,
    whisperBin: fakeWhisper,
    model: "model.bin",
  });

  const args = readFileSync(argsFile, "utf8").trim().split("\n");
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after("-m"), "model.bin");
  assert.equal(after("-l"), "en");
  // whisper.cpp 1.9.5 maps VAD times back to the video wrong: words after a silence come out seconds early.
  assert.ok(!args.includes("--vad") && !args.includes("-vm"), "voice detection is on");
  assert.equal(after("-ml"), "1");
  assert.ok(args.includes("-sow") && args.includes("-oj"), "words are not written as JSON");
  assert.equal(after("-f"), path.join(dir, "audio.wav"));
  assert.equal(words.length, 22);
});

test("wordsFromWhisperJson reads one word per segment and skips the empty one", () => {
  const words = wordsFromWhisperJson(JSON.parse(readFileSync(FIXTURE, "utf8")));
  assert.deepEqual(words.slice(0, 6), [
    { text: "And", startMs: 320, endMs: 370 },
    { text: "so", startMs: 370, endMs: 690 },
    { text: "my", startMs: 690, endMs: 850 },
    { text: "fellow", startMs: 850, endMs: 1590 },
    { text: "Americans,", startMs: 1590, endMs: 3300 },
    { text: "ask", startMs: 3300, endMs: 4140 },
  ]);
  assert.deepEqual(words.at(-1), { text: "country.", startMs: 10020, endMs: 10510 });
});

test("wordsFromWhisperJson ends a word where the next one starts when whisper ran it past that", () => {
  const segment = (text, from, to) => ({ text, offsets: { from, to } });
  const words = wordsFromWhisperJson({
    transcription: [segment(" a", 1000, 1100), segment(" b", 1040, 1300)],
  });
  assert.deepEqual(words, [
    { text: "a", startMs: 1000, endMs: 1040 },
    { text: "b", startMs: 1040, endMs: 1300 },
  ]);
});

test("wordsFromWhisperJson keeps the words after a silence at the time they are said", () => {
  // Speech, 10 s of silence, speech: without --vad whisper's offsets are times in the video, kept as they are.
  const segment = (text, from, to) => ({ text, offsets: { from, to } });
  const words = wordsFromWhisperJson({
    transcription: [
      segment(" Hello", 1000, 1400),
      segment(" there.", 1400, 1900),
      segment(" Welcome", 12000, 12500),
      segment(" back.", 12500, 13100),
    ],
  });
  assert.deepEqual(
    words.map(({ text, startMs }) => [text, startMs]),
    [["Hello", 1000], ["there.", 1400], ["Welcome", 12000], ["back.", 12500]],
  );
  // Word by word, the line after the silence shows up when its first word is said, not before.
  const stills = captionStills(captionLines(words), true);
  assert.deepEqual(
    stills.map(({ highlight, startMs, endMs }) => [highlight, startMs, endMs]),
    [[0, 1000, 1400], [1, 1400, 1900], [0, 12000, 12500], [1, 12500, 13100]],
  );
});
