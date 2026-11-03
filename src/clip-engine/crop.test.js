import { afterAll, beforeAll, test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cameraPath,
  cropCommands,
  cropKeyframes,
  cropPixels,
  DEAD_ZONE,
  framingFilter,
  MAX_SPEED,
  MIN_FIT_SECONDS,
  parseCropMode,
  SAMPLE_FPS,
} from "./crop.js";
import { renderClip } from "./ffmpeg.js";
import { followCrop } from "./follow.js";
import { FPS } from "./pacing.js";

const point = (centre) => ({ centre, left: centre, right: centre });
const samplesOf = (seconds, subjectAt) =>
  Array.from({ length: seconds * SAMPLE_FPS }, (_, i) => {
    const t = i / SAMPLE_FPS;
    return { t, subject: subjectAt(t) };
  });
const CROP = 607 / 1920;

test("parseCropMode takes the three modes only", () => {
  assert.equal(parseCropMode("follow"), "follow");
  assert.throws(() => parseCropMode("left"), /crop must be one of centre, follow, fit/);
});

test("cropPixels is the even 9:16 width, or the whole width of a narrower source", () => {
  assert.equal(cropPixels(1920, 1080), 606);
  assert.equal(cropPixels(1080, 1920), 1080);
});

test("cameraPath holds still for a subject that moves within the dead-zone", () => {
  // Swaying by less than the dead-zone from one side to the other.
  const small = DEAD_ZONE * CROP * 0.4;
  const { centres, fit } = cameraPath(samplesOf(6, (t) => point(0.5 + Math.sin(t * 3) * small)), {
    cropWidth: CROP,
    cuts: [],
    length: 6,
  });
  assert.ok(centres.every(({ centre }) => Math.abs(centre - centres[0].centre) < 1e-9), "the camera moved");
  assert.deepEqual(fit, []);
});

test("cameraPath follows a move, never faster than the speed limit, and eases in", () => {
  // The subject jumps from the left third to the right third.
  const { centres } = cameraPath(samplesOf(6, (t) => point(t < 1 ? 0.3 : 0.7)), { cropWidth: CROP, cuts: [], length: 6 });
  const speeds = centres.slice(1).map((c, i) => Math.abs(c.centre - centres[i].centre) * SAMPLE_FPS);
  assert.ok(Math.max(...speeds) <= MAX_SPEED + 1e-9, `moved at ${Math.max(...speeds)} widths/s`);
  const firstMove = speeds.findIndex((speed) => speed > 0);
  assert.ok(speeds[firstMove] < speeds[firstMove + 1], "the camera did not ease in");
  assert.ok(Math.abs(centres.at(-1).centre - 0.7) < 0.03 * CROP, `ended at ${centres.at(-1).centre}`);
});

test("cameraPath leads: it starts moving before the subject does", () => {
  const { centres } = cameraPath(samplesOf(6, (t) => point(t < 3 ? 0.3 : 0.7)), { cropWidth: CROP, cuts: [], length: 6 });
  const moved = centres.find(({ centre }) => centre !== centres[0].centre);
  assert.ok(moved.t < 3, `first moved at ${moved.t}s`);
});

test("cameraPath resets at a hard cut instead of panning across it", () => {
  const { centres } = cameraPath(samplesOf(6, (t) => point(t < 3 ? 0.25 : 0.75)), { cropWidth: CROP, cuts: [3], length: 6 });
  const before = centres.filter(({ t }) => t < 3);
  const after = centres.filter(({ t }) => t >= 3);
  assert.ok(before.every(({ centre }) => Math.abs(centre - 0.25) < 1e-9), "the camera left before the cut");
  assert.ok(after.every(({ centre }) => Math.abs(centre - 0.75) < 1e-9), "the camera panned after the cut");
  const keyframes = cropKeyframes(centres, { width: 1920, crop: 606, cuts: [3] });
  const jump = keyframes.filter(({ t }) => t === 3);
  assert.deepEqual(jump.map(({ x }) => x), [177, 1137, 1137]);
});

test("cameraPath fits the stretch where two subjects are wider than the crop, and a move faster than the camera", () => {
  const wide = cameraPath(
    samplesOf(8, (t) => (t >= 3 && t < 5 ? { centre: 0.5, left: 0.2, right: 0.8 } : point(0.5))),
    { cropWidth: CROP, cuts: [], length: 8 },
  );
  // The last wide sample is at 4.75 s; each sample stands for its quarter second.
  assert.deepEqual(wide.fit, [{ start: 2.875, end: 4.875 }]);

  // Across the whole frame in under a second.
  const fast = cameraPath(samplesOf(8, (t) => point(t < 4 ? 0.1 : t < 4.75 ? 0.1 + ((t - 4) / 0.75) * 0.8 : 0.9)), {
    cropWidth: CROP,
    cuts: [],
    length: 8,
  });
  assert.equal(fast.fit.length, 1);
  assert.ok(fast.fit[0].end - fast.fit[0].start >= MIN_FIT_SECONDS);
  assert.ok(fast.fit[0].start < 4.75 && fast.fit[0].end > 4.75);
});

test("cropCommands moves the crop in straight lines between keyframes, and jumps at cuts", () => {
  const commands = cropCommands([
    { t: 0, x: 100 },
    { t: 1, x: 100 },
    { t: 2, x: 50 },
    { t: 2.5, x: 50 },
    { t: 2.5, x: 900 },
    { t: 3, x: 900 },
  ]);
  assert.equal(
    commands,
    ["0.000 crop@follow x 100;", "1.000 crop@follow x 100-50*(t-1);", "2.000 crop@follow x 50;", "2.500 crop@follow x 900;", ""].join("\n"),
  );
});

test("framingFilter needs a plain commands file name for a followed crop", () => {
  const crop = { mode: "follow", width: 606, keyframes: [{ t: 0, x: 10 }], fit: [{ start: 1, end: 2 }] };
  assert.throws(() => framingFilter(crop, "out", "C:/work/a.cmd"), /plain name/);
  assert.match(framingFilter(crop, "out", "a.crop.cmd"), /^\[0:v\]sendcmd=f=a\.crop\.cmd,split.*overlay=enable='between\(t,1,2\)'\[out\]$/);
});

// A bright 120 px square that crosses a 1920×1080 frame from right to left in 6 s, from x 1700 to 200.
let dir;
let source;
const SQUARE = 120;
const noDetections = { faces: async () => [], objects: async () => [] };

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "crop-test-"));
  source = path.join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x202020:s=1920x1080:r=30:d=6",
    "-f", "lavfi", "-i", `color=c=white:s=${SQUARE}x${SQUARE}:r=30:d=6`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=6",
    "-filter_complex", "[0:v][1:v]overlay=x='1700-1500*t/6':y=480[v]",
    "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// How many pixels of the frame at t are bright, out of a 1080×1920 picture.
function brightPixels(file, t) {
  const gray = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1",
  ], { maxBuffer: 1e8 });
  assert.equal(gray.length, 1080 * 1920);
  let count = 0;
  for (const value of gray) if (value > 200) count++;
  return count;
}

// The square, scaled up with the 606 px crop to 1080 wide.
const wholeSquare = (SQUARE * 1080 / 606) ** 2;

test("a followed crop keeps the square moving right to left inside the picture, by its motion", async () => {
  const crop = await followCrop({ input: source, start: 0, length: 6, detectors: noDetections });
  assert.equal(crop.mode, "follow");
  assert.deepEqual(crop.fit, []);
  const output = path.join(dir, "follow.mp4");
  await renderClip({ input: source, output, start: 0, length: 6, overlay: null, crop });
  for (let t = 0.5; t < 5.8; t += 0.5) {
    const bright = brightPixels(output, t);
    assert.ok(bright > 0.9 * wholeSquare, `at ${t}s only ${bright} of ${Math.round(wholeSquare)} square pixels show`);
  }
  // The centre crop loses it on both sides.
  const centre = path.join(dir, "centre.mp4");
  await renderClip({ input: source, output: centre, start: 0, length: 6, overlay: null });
  assert.equal(brightPixels(centre, 0.5), 0);
  assert.equal(brightPixels(centre, 5.5), 0);
});

test("a fitted crop is 1080×1920 with the whole frame in the middle", async () => {
  const output = path.join(dir, "fit.mp4");
  await renderClip({ input: source, output, start: 0, length: 2, overlay: null, crop: { mode: "fit" } });
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", output], { encoding: "utf8" }));
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  // The square at its full-frame size, 120 × 1080/1920, near the right edge at 0.5 s.
  const bright = brightPixels(output, 0.5);
  assert.ok(bright > 0.8 * (SQUARE * 1080 / 1920) ** 2, `${bright} bright pixels`);
});

test("a followed crop still keeps the square in the picture once tightened", async () => {
  const crop = await followCrop({ input: source, start: 0, length: 6, detectors: noDetections });
  // A second is cut from 2 s to 3 s.
  const keep = [{ start: 0, end: 60 / FPS }, { start: 90 / FPS, end: 180 / FPS }];
  const output = path.join(dir, "tight.mp4");
  await renderClip({ input: source, output, start: 0, length: 6, overlay: null, crop, tightened: { keep, length: 5 } });
  for (let t = 0.5; t < 4.8; t += 0.5) {
    const bright = brightPixels(output, t);
    assert.ok(bright > 0.9 * wholeSquare, `at ${t}s only ${bright} of ${Math.round(wholeSquare)} square pixels show`);
  }
});
