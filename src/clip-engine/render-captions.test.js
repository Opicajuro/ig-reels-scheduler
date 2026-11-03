import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { END_CARD_SECONDS, HOOK_SECONDS, overlayList, renderBlankOverlay, renderClip } from "./ffmpeg.js";
import { renderCaptionStills, renderTitleStills, withCaptionBundle } from "./render-captions.js";

function grayFrame(file, seconds) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { maxBuffer: 16 * 1024 * 1024 });
}

// The frame at seconds as RGB, cropped to rows y to y + height.
function rgbRows(file, seconds, y, height) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1",
    "-vf", `format=rgb24,crop=iw:${height}:0:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { maxBuffer: 16 * 1024 * 1024 });
}

function grayRows(file, seconds, y, height) {
  return execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1",
    "-vf", `crop=iw:${height}:0:${y}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { maxBuffer: 16 * 1024 * 1024 });
}

// A PNG still as RGBA.
function stillPixels(file) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], {
    maxBuffer: 32 * 1024 * 1024,
  });
}

// Pixels that are clearly drawn and clearly coloured, unlike white text and its grey shadow.
function colouredPixels(rgba, test = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 80) {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 200 && test(rgba[i], rgba[i + 1], rgba[i + 2])) count++;
  return count;
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
    { words: ["hello", "world"], image: path.join(dir, "caption-0.png"), start: 0.5, end: 2 },
    { words: ["second", "line"], image: path.join(dir, "caption-1.png"), start: 3, end: 4.5 },
  ];
  await withCaptionBundle((serveUrl) =>
    renderCaptionStills({
      serveUrl,
      stills: overlays.map(({ words, image }) => ({ words, highlight: null, output: image })),
      chromePath: process.env.CHROME_PATH,
      preset: "classic",
    }),
  );
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

test("word-by-word stills highlight the word being spoken", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "captions-words-test-"));
  const source = path.join(dir, "source.mp4");
  const blank = path.join(dir, "blank.png");
  const list = path.join(dir, "overlays.ffconcat");
  const output = path.join(dir, "captioned.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:duration=4:size=1920x1080:rate=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    source,
  ]);

  const words = ["hello", "world"];
  const overlays = [
    { highlight: 0, image: path.join(dir, "word-0.png"), start: 0.5, end: 1.5 },
    { highlight: 1, image: path.join(dir, "word-1.png"), start: 1.5, end: 2.5 },
  ];
  await withCaptionBundle((serveUrl) =>
    renderCaptionStills({
      serveUrl,
      stills: overlays.map(({ highlight, image }) => ({ words, highlight, output: image })),
      chromePath: process.env.CHROME_PATH,
      preset: "words",
    }),
  );
  await renderBlankOverlay(blank);
  writeFileSync(list, overlayList({ overlays, blank, length: 3 }));
  await renderClip({ input: source, output, start: 0, length: 3, overlay: list });

  const gap = grayFrame(output, 2.75);
  const first = grayFrame(output, 1);
  const second = grayFrame(output, 2);
  assert.ok(changedPixels(first, gap) > 1000, "the line is missing while the first word is spoken");
  assert.ok(changedPixels(second, gap) > 1000, "the line is missing while the second word is spoken");
  // The highlight moved from "hello" to "world", so the two frames differ in many pixels.
  assert.ok(changedPixels(first, second) > 1000, "the highlighted word did not change");
});

test("the hook title shows at the top for the first seconds, the end card for the last ones, and the bar grows", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "captions-extras-test-"));
  const source = path.join(dir, "source.mp4");
  const hook = path.join(dir, "hook.png");
  const endCard = path.join(dir, "end-card.png");
  const output = path.join(dir, "clip.mp4");
  const length = 6;
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:duration=7:size=1920x1080:rate=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    source,
  ]);
  await withCaptionBundle((serveUrl) =>
    renderTitleStills({
      serveUrl,
      stills: [
        { kind: "hook", text: "Wait for the end", output: hook },
        { kind: "endCard", text: "@myhandle", output: endCard },
      ],
      chromePath: process.env.CHROME_PATH,
      font: "anton",
    }),
  );
  await renderClip({ input: source, output, start: 0, length, overlay: null, hook, endCard, progressColor: "#22d3ee" });

  // The hook sits in the top fifth; the middle of the clip is plain gray.
  const top = (seconds) => grayRows(output, seconds, 0, 384);
  const plainTop = top(3);
  assert.ok(changedPixels(top(0), plainTop) > 5000, "the hook is missing from the first frame");
  assert.ok(changedPixels(top(HOOK_SECONDS - 0.1), plainTop) > 5000, "the hook ends early");
  assert.ok(changedPixels(top(HOOK_SECONDS), plainTop) < 100, "the hook stays past its seconds");

  const middle = (seconds) => grayRows(output, seconds, 800, 320);
  const plainMiddle = middle(3);
  assert.ok(changedPixels(middle(length - END_CARD_SECONDS), plainMiddle) > 5000, "the end card starts late");
  assert.ok(changedPixels(middle(length - 0.1), plainMiddle) > 5000, "the end card is missing at the end");
  assert.ok(changedPixels(middle(length - END_CARD_SECONDS - 0.1), plainMiddle) < 100, "the end card starts early");

  // The bar is cyan along the bottom rows, as long as the share of the clip played so far.
  const barWidth = (seconds) => {
    const row = rgbRows(output, seconds, 1914, 1);
    let width = 0;
    for (let i = 0; i < row.length; i += 3) if (row[i + 2] > 180 && row[i] < 120) width++;
    return width;
  };
  for (const seconds of [1, 3, 4]) {
    const expected = (1080 * seconds) / length;
    assert.ok(Math.abs(barWidth(seconds) - expected) < 20, `the bar is ${barWidth(seconds)}px at ${seconds}s, not ${expected}`);
  }
  assert.equal(grayRows(output, 3, 1800, 100).length, 1080 * 100);
});

test("caption stills draw in the chosen font, highlight colour and with the line's emoji", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "captions-look-test-"));
  const chromePath = process.env.CHROME_PATH;
  const words = ["show", "me", "the", "money"];
  const fonts = ["default", "montserrat", "anton", "bebas"];
  await withCaptionBundle((serveUrl) =>
    Promise.all([
    renderCaptionStills({
      serveUrl,
      chromePath,
      preset: "classic",
      stills: [{ words, highlight: null, emoji: "💰", output: path.join(dir, "emoji.png") }],
    }),
    ...fonts.map((font) =>
      renderCaptionStills({
        serveUrl,
        chromePath,
        preset: "classic",
        font,
        stills: [{ words, highlight: null, output: path.join(dir, `${font}.png`) }],
      }),
    ),
    renderCaptionStills({
      serveUrl,
      chromePath,
      preset: "words",
      highlightColor: "green",
      stills: [{ words, highlight: 3, output: path.join(dir, "green.png") }],
    }),
    ]),
  );

  const drawn = Object.fromEntries(fonts.map((font) => [font, stillPixels(path.join(dir, `${font}.png`))]));
  for (const [index, font] of fonts.entries()) {
    for (const other of fonts.slice(index + 1)) {
      assert.ok(changedPixels(drawn[font], drawn[other]) > 1000, `${font} and ${other} look the same`);
    }
  }
  // White text has no coloured pixels; the money bag does.
  assert.equal(colouredPixels(drawn.default), 0);
  assert.ok(colouredPixels(stillPixels(path.join(dir, "emoji.png"))) > 500, "the emoji is missing or not in colour");
  const green = colouredPixels(stillPixels(path.join(dir, "green.png")), (r, g, b) => g > 180 && r < 120 && b < 160);
  assert.ok(green > 2000, "the highlight is not green");
});
