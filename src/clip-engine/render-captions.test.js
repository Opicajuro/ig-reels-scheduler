import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleCaptions, renderCaptions } from "./render-captions.js";

test("renderCaptions writes a captioned 9:16 clip of the same length", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "captions-test-"));
  const publicDir = path.join(dir, "public");
  mkdirSync(publicDir);
  const clipPath = path.join(publicDir, "clip-001.mp4");
  const output = path.join(dir, "captioned.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=4:size=1080x1920:rate=30",
    "-f", "lavfi", "-i", "sine=duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    clipPath,
  ]);

  await renderCaptions({
    serveUrl: await bundleCaptions(publicDir),
    src: "clip-001.mp4",
    durationSeconds: 4,
    captions: [{ text: "hello world", startMs: 500, endMs: 2000, timestampMs: 500, confidence: 1 }],
    output,
    chromePath: process.env.CHROME_PATH,
    preset: "classic",
  });

  const info = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", output]),
  );
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(Math.round(Number(info.format.duration)), 4);
});
