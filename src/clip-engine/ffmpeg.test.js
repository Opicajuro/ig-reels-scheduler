import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertAiVideo } from "./ffmpeg.js";

test("convertAiVideo turns a silent 704x1280 24 fps AI video into 1080x1920 30 fps H.264 with a silent AAC track", async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "local-clips-ai-convert-"));
  try {
    // What ComfyUI's SaveVideo writes for the Wan 2.2 5B workflow: 49 frames at 24 fps, no audio.
    const input = path.join(workDir, "generated.mp4");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=704x1280:rate=24",
      "-frames:v", "49",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      input,
    ]);
    const output = path.join(workDir, "converted.mp4");
    await convertAiVideo({ input, output });

    const probe = JSON.parse(
      execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", output], { encoding: "utf8" }),
    );
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    const audio = probe.streams.find((stream) => stream.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, 1080);
    assert.equal(video.height, 1920);
    assert.equal(video.r_frame_rate, "30/1");
    assert.equal(video.pix_fmt, "yuv420p");
    assert.equal(audio.codec_name, "aac");
    assert.equal(audio.sample_rate, "48000");
    assert.equal(audio.channels, 2);
    // The silent track ends with the picture.
    assert.ok(Math.abs(Number(probe.format.duration) - 49 / 24) < 0.15, `duration ${probe.format.duration}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
