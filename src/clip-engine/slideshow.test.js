import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildVoiceTrack, preparePicture, renderSlideshow, slideshowFilter, slideTimings } from "./slideshow.js";

function meanVolume(file, from, length) {
  const { stderr } = spawnSync("ffmpeg", ["-ss", String(from), "-t", String(length), "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf8",
  });
  return Number(/mean_volume: (-?[\d.]+|-inf) dB/.exec(stderr)[1].replace("-inf", "-Infinity"));
}

function probe(file) {
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file], { encoding: "utf8" }),
  );
}

test("slideTimings gives each slide its line plus 0.3 s, in whole frames, with the crossfade added to all but the last", () => {
  const timings = slideTimings([1.0, 2.02, 0.5]);
  assert.deepEqual(timings.slides, [
    { start: 0, slot: 1.3, frames: 39 + 12 },
    // 2.32 s is 69.6 frames: it rounds to 70.
    { start: 1.3, slot: 70 / 30, frames: 70 + 12 },
    { start: (39 + 70) / 30, slot: 0.8, frames: 24 },
  ]);
  assert.equal(timings.total, (39 + 70 + 24) / 30);
  assert.throws(() => slideTimings([]), /at least one slide/);
  assert.throws(() => slideTimings([1, 0]), /voice of slide 2 is empty/);
});

test("slideshowFilter zooms in and pans by turns and crossfades for 0.4 s at each slide's start", () => {
  const timings = slideTimings([1.0, 1.1, 1.2]);
  const graph = slideshowFilter({ timings, captions: false }).split(";");
  assert.deepEqual(graph, [
    "[0:v]scale=2160:3840,zoompan=z='1+0.15*on/50':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=51:s=1080x1920:fps=30,setsar=1,format=yuv420p,settb=AVTB[s0]",
    "[1:v]scale=2160:3840,zoompan=z='1.15':x='(iw-iw/zoom)*on/53':y='ih/2-(ih/zoom/2)':d=54:s=1080x1920:fps=30,setsar=1,format=yuv420p,settb=AVTB[s1]",
    "[2:v]scale=2160:3840,zoompan=z='1+0.15*on/44':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=45:s=1080x1920:fps=30,setsar=1,format=yuv420p,settb=AVTB[s2]",
    "[s0][s1]xfade=transition=fade:duration=0.4:offset=1.300[x1]",
    "[x1][s2]xfade=transition=fade:duration=0.4:offset=2.700[x2]",
    "[x2]null[out]",
  ]);
  // The captions are input 4: after the three pictures and the voice.
  assert.equal(slideshowFilter({ timings, captions: true }).split(";").at(-1), "[x2][4:v]overlay[out]");
});

test("a 3-slide show of solid colours with a sine voice renders at 1080x1920 30 fps for the voice plus pauses", async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "local-clips-slideshow-"));
  try {
    const pictures = [];
    for (const [index, colour] of ["red", "green", "blue"].entries()) {
      // Pictures of other shapes are cropped to fill.
      const still = path.join(workDir, `${colour}.png`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${colour}:s=${index === 1 ? "1920x1080" : "768x1344"}`, "-frames:v", "1", still]);
      const picture = path.join(workDir, `picture-${index}.png`);
      await preparePicture({ input: still, output: picture });
      const [stream] = probe(picture).streams;
      assert.equal(`${stream.width}x${stream.height}`, "1080x1920");
      pictures.push(picture);
    }
    // Kokoro writes 24 kHz mono lines.
    const seconds = [1.0, 1.5, 0.8];
    const lines = seconds.map((length, index) => {
      const line = path.join(workDir, `line-${index}.wav`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=${300 + index * 100}:duration=${length}`, "-ar", "24000", "-ac", "1", line]);
      return line;
    });
    const timings = slideTimings(seconds);
    const voice = path.join(workDir, "voice.wav");
    await buildVoiceTrack({ lines, timings, output: voice });
    assert.ok(Math.abs(Number(probe(voice).format.duration) - timings.total) < 0.01);

    const output = path.join(workDir, "slideshow.mp4");
    await renderSlideshow({ pictures, voice, timings, overlay: null, output });

    const result = probe(output);
    const video = result.streams.find((stream) => stream.codec_type === "video");
    const audio = result.streams.find((stream) => stream.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, 1080);
    assert.equal(video.height, 1920);
    assert.equal(video.r_frame_rate, "30/1");
    assert.equal(audio.codec_name, "aac");
    // 1.3 + 1.8 + 1.1 seconds.
    assert.equal(timings.total, 4.2);
    assert.ok(Math.abs(Number(result.format.duration) - 4.2) < 0.1, `duration ${result.format.duration}`);

    // The middle of slide 2 is green, and its voice line is playing there.
    const frame = execFileSync("ffmpeg", ["-v", "error", "-ss", "2.2", "-i", output, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    assert.ok(frame[1] > 100 && frame[0] < 60 && frame[2] < 60, `pixel ${[...frame]}`);
    assert.ok(meanVolume(output, 2.0, 0.5) > -30);
    // Its 0.3 s pause after the line is silent.
    assert.ok(meanVolume(output, 2.85, 0.2) < -80);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
