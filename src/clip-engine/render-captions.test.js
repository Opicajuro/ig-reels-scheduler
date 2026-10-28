import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderClip } from "./ffmpeg.js";
import { bundleCaptions, renderCaptionStills } from "./render-captions.js";

function grayFrame(file, seconds) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { maxBuffer: 16 * 1024 * 1024 });
}

test("a caption still laid over a clip shows only while the caption is spoken", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "captions-test-"));
  const source = path.join(dir, "source.mp4");
  const image = path.join(dir, "caption.png");
  const output = path.join(dir, "captioned.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:duration=6:size=1920x1080:rate=30",
    "-f", "lavfi", "-i", "sine=duration=6",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    source,
  ]);

  await renderCaptionStills({
    serveUrl: await bundleCaptions(),
    stills: [{ text: "hello world", output: image }],
    chromePath: process.env.CHROME_PATH,
    preset: "classic",
  });
  await renderClip({ input: source, output, start: 1, length: 4, overlays: [{ image, start: 0.5, end: 2 }] });

  const info = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", output]),
  );
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(Math.round(Number(info.format.duration)), 4);

  const during = grayFrame(output, 1);
  const after = grayFrame(output, 3);
  let changed = 0;
  for (let i = 0; i < during.length; i++) if (Math.abs(during[i] - after[i]) > 40) changed++;
  assert.ok(changed > 1000, `only ${changed} pixels changed where the caption should be`);
});
