import { cameraPath, cropKeyframes, cropPixels, SAMPLE_FPS } from "./crop.js";
import { probeVideoSize, sampledFrames, sceneCuts } from "./ffmpeg.js";
import { findSubject } from "./subject.js";

// Subjects are looked for in frames scaled to fit this square.
const SAMPLE_SIZE = 640;

const even = (value) => Math.max(2, Math.round(value / 2) * 2);

// The crop that follows the action through a clip's stretch of the source (start, length seconds), from its subjects
// found by detectors (subject.js loadDetectors) and its hard cuts. A source no wider than 9:16 has nothing to follow
// and keeps the centre.
/**
 * @param {{ input: string; start: number; length: number; detectors: { faces: Function; objects: Function } }} options
 * @returns {Promise<import("./crop.js").Crop>}
 */
export async function followCrop({ input, start, length, detectors }) {
  const { width, height } = await probeVideoSize(input);
  const crop = cropPixels(width, height);
  if (crop >= width) return { mode: "centre" };
  const scale = SAMPLE_SIZE / Math.max(width, height);
  const size = { width: even(width * scale), height: even(height * scale) };
  const [cuts, samples] = await Promise.all([
    sceneCuts({ input, start, length }),
    (async () => {
      const found = [];
      let previous = null;
      for await (const frame of sampledFrames({ input, start, length, ...size, fps: SAMPLE_FPS })) {
        const { subject, gray } = await findSubject(frame, previous, detectors);
        found.push({ t: found.length / SAMPLE_FPS, subject });
        previous = gray;
      }
      return found;
    })(),
  ]);
  if (samples.length === 0) throw new Error(`no frames from ${start}s to ${start + length}s to follow`);
  const { centres, fit } = cameraPath(samples, { cropWidth: crop / width, cuts, length });
  return { mode: "follow", width: crop, keyframes: cropKeyframes(centres, { width, crop, cuts }), fit };
}
