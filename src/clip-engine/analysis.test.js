import { test } from "vitest";
import assert from "node:assert/strict";
import { loudnessPerSecond, motionPerSecond } from "./analysis.js";
import { MOTION_HEIGHT, MOTION_WIDTH, SAMPLES_PER_SECOND } from "./helpers.js";

async function* chunksOf(buffers) {
  for (const buffer of buffers) yield buffer;
}

const FRAME_SIZE = MOTION_WIDTH * MOTION_HEIGHT;

test("motionPerSecond averages frame-to-frame change within each second", async () => {
  const black = Buffer.alloc(FRAME_SIZE, 0);
  const white = Buffer.alloc(FRAME_SIZE, 255);
  // Frame 0 black, frame 1 onward white. The change happens at frame 1, which is second 0.
  const frames = [black, white, white, white, white, white, white, white];
  const motion = await motionPerSecond(chunksOf([Buffer.concat(frames)]), 2);
  // Second 0 has diffs at frames 1, 2, 3 (255, 0, 0) => mean 85. Second 1 has frames 4..7 => 0.
  assert.deepEqual(motion, [85, 0]);
});

test("motionPerSecond handles frames split across chunk boundaries", async () => {
  const black = Buffer.alloc(FRAME_SIZE, 0);
  const white = Buffer.alloc(FRAME_SIZE, 255);
  const all = Buffer.concat([black, white, white, white, white, white, white, white]);
  const splitAt = Math.floor(all.length / 3);
  const motion = await motionPerSecond(chunksOf([all.subarray(0, splitAt), all.subarray(splitAt)]), 2);
  assert.deepEqual(motion, [85, 0]);
});

test("motionPerSecond gives a zero score to seconds without frames", async () => {
  const motion = await motionPerSecond(chunksOf([]), 3);
  assert.deepEqual(motion, [0, 0, 0]);
});

function samplesPerSecond(value, seconds) {
  const buffer = Buffer.alloc(seconds * 8000 * 2);
  for (let offset = 0; offset < buffer.length; offset += 2) buffer.writeInt16LE(value, offset);
  return buffer;
}

test("loudnessPerSecond returns the RMS level of each second", async () => {
  const quiet = samplesPerSecond(0, 1);
  const loud = samplesPerSecond(1000, 1);
  const levels = await loudnessPerSecond(chunksOf([Buffer.concat([quiet, loud])]), 2);
  assert.deepEqual(levels, [0, 1000]);
});

test("loudnessPerSecond handles a sample split across chunk boundaries", async () => {
  const loud = samplesPerSecond(-500, 1);
  const levels = await loudnessPerSecond(chunksOf([loud.subarray(0, 3), loud.subarray(3)]), 1);
  assert.deepEqual(levels, [500]);
});

test("the motion sample rate matches the constant the ffmpeg filter uses", () => {
  assert.equal(SAMPLES_PER_SECOND, 4);
});
