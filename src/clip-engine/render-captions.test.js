import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { overlayList, renderBlankOverlay, renderClip } from "./ffmpeg.js";
import { bundleCaptions, renderCaptionStills } from "./render-captions.js";

function grayFrame(file, seconds) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { maxBuffer: 16 * 1024 * 1024 });
}

function changedPixels(a, b) {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) changed++;
  return changed;
}

test("caption stills laid over a clip show only while each caption is spoken", async () => {
  // A quote and a backslash in the folder name check the paths are quoted right in the overlay list.
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "captions-test-")), "it's a\\dir");
  mkdirSync(dir);
  const source = path.join(dir, "source.mp4");
  const blank = path.join(dir, "blank.png");
  const list = path.join(dir, "overlays.ffconcat");
  const output = path.join(dir, "captioned.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:duration=8:size=1920x1080:rate=30",
    "-f", "lavfi", "-i", "sine=duration=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    source,
  ]);

  const overlays = [
    { text: "hello world", image: path.join(dir, "caption-0.png"), start: 0.5, end: 2 },
    { text: "second line", image: path.join(dir, "caption-1.png"), start: 3, end: 4.5 },
  ];
  await renderCaptionStills({
    serveUrl: await bundleCaptions(),
    stills: overlays.map(({ text, image }) => ({ text, output: image })),
    chromePath: process.env.CHROME_PATH,
    preset: "classic",
  });
  await renderBlankOverlay(blank);
  writeFileSync(list, overlayList({ overlays, blank, length: 6 }));
  await renderClip({ input: source, output, start: 1, length: 6, overlay: list });

  const info = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", output]),
  );
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.equal(Math.round(Number(info.format.duration)), 6);

  const gap = grayFrame(output, 2.5);
  assert.ok(changedPixels(grayFrame(output, 1), gap) > 1000, "first caption is missing");
  assert.ok(changedPixels(grayFrame(output, 3.75), gap) > 1000, "second caption is missing");
  // Frame exact: the first frame at a caption's start shows it, the first frame at its end does not.
  assert.ok(changedPixels(grayFrame(output, 0.5), gap) > 1000, "first caption starts late");
  assert.ok(changedPixels(grayFrame(output, 4.5), gap) < 100, "second caption ends late");
  assert.ok(changedPixels(grayFrame(output, 0.2), gap) < 100, "a caption shows before the first one starts");
  assert.ok(changedPixels(grayFrame(output, 5.5), gap) < 100, "a caption shows after the last one ends");
});
