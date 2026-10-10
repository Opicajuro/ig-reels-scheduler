import {
  AUDIO_SAMPLE_RATE,
  MOTION_HEIGHT,
  MOTION_WIDTH,
  SAMPLES_PER_SECOND,
} from "./helpers.js";

const FRAME_SIZE = MOTION_WIDTH * MOTION_HEIGHT;

function meanAbsoluteDifference(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

export async function motionPerSecond(frames, durationSeconds) {
  const seconds = Math.ceil(durationSeconds);
  const sums = new Float64Array(seconds);
  const counts = new Uint32Array(seconds);
  let pending = Buffer.alloc(0);
  let previous = null;
  let frameIndex = 0;

  for await (const chunk of frames) {
    pending = Buffer.concat([pending, chunk]);
    let offset = 0;
    while (pending.length - offset >= FRAME_SIZE) {
      const frame = pending.subarray(offset, offset + FRAME_SIZE);
      offset += FRAME_SIZE;
      if (previous) {
        const second = Math.floor(frameIndex / SAMPLES_PER_SECOND);
        if (second < seconds) {
          sums[second] += meanAbsoluteDifference(previous, frame);
          counts[second]++;
        }
      }
      previous = frame;
      frameIndex++;
    }
    pending = pending.subarray(offset);
  }

  return Array.from(sums, (sum, second) => (counts[second] ? sum / counts[second] : 0));
}

export async function loudnessPerSecond(samples, durationSeconds) {
  const seconds = Math.ceil(durationSeconds);
  const sumSquares = new Float64Array(seconds);
  const counts = new Uint32Array(seconds);
  let pending = Buffer.alloc(0);
  let sampleIndex = 0;

  for await (const chunk of samples) {
    pending = Buffer.concat([pending, chunk]);
    const usable = pending.length - (pending.length % 2);
    for (let offset = 0; offset < usable; offset += 2) {
      const value = pending.readInt16LE(offset);
      const second = Math.floor(sampleIndex / AUDIO_SAMPLE_RATE);
      if (second < seconds) {
        sumSquares[second] += value * value;
        counts[second]++;
      }
      sampleIndex++;
    }
    pending = pending.subarray(usable);
  }

  return Array.from(sumSquares, (sum, second) => (counts[second] ? Math.sqrt(sum / counts[second]) : 0));
}
