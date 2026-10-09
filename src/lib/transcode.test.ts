import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { transcodeToReel } from "./transcode";

function makeFixture(name: string, withAudio: boolean): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "transcode-test-"));
  const file = path.join(dir, name);
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=640x360:rate=25"];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=duration=4");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(file);
  execFileSync("ffmpeg", args);
  return file;
}

describe("transcodeToReel", () => {
  it("produces a 1080x1920 MP4 that passes the Reel spec", async () => {
    const input = makeFixture("with-audio.mp4", true);
    const output = path.join(mkdtempSync(path.join(os.tmpdir(), "reel-out-")), "reel.mp4");

    const result = await transcodeToReel({ inputPath: input, outputPath: output });

    expect(result.durationSeconds).toBeGreaterThanOrEqual(3);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
  });

  it("fails with 'no audio stream' when the source has no audio", async () => {
    const input = makeFixture("silent.mp4", false);
    const output = path.join(mkdtempSync(path.join(os.tmpdir(), "reel-out-")), "reel.mp4");

    await expect(transcodeToReel({ inputPath: input, outputPath: output })).rejects.toThrow("no audio stream");
  });
});
