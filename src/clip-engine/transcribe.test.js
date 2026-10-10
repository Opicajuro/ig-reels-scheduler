import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { transcribeToCaptions } from "./transcribe.js";

test("transcribeToCaptions runs whisper-cli on the audio and returns its captions", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "transcribe-test-"));
  const media = path.join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    media,
  ]);

  const fakeWhisper = path.join(dir, "fake-whisper.sh");
  writeFileSync(
    fakeWhisper,
    [
      "#!/bin/sh",
      "prefix=",
      "while [ $# -gt 0 ]; do",
      '  case "$1" in -of) prefix="$2"; shift;; esac',
      "  shift",
      "done",
      'printf "1\\n00:00:00,500 --> 00:00:01,500\\nhello world\\n" > "$prefix.srt"',
      "",
    ].join("\n"),
  );
  chmodSync(fakeWhisper, 0o755);

  const captions = await transcribeToCaptions({
    mediaPath: media,
    workDir: dir,
    whisperBin: fakeWhisper,
    model: "unused-by-fake.bin",
  });

  assert.deepEqual(captions.map((c) => [c.text, c.startMs, c.endMs]), [["hello world", 500, 1500]]);
});
