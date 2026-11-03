import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mixBackgroundMusic, musicMixFilter } from "./music.js";

describe("musicMixFilter", () => {
  it("loops, trims, fades and ducks the music under the clip's sound", () => {
    const filter = musicMixFilter({ length: 20, volume: 15, withSound: true });
    expect(filter).toContain("[1:a]");
    expect(filter).toContain("atrim=0:20.000");
    expect(filter).toContain("volume=0.15");
    expect(filter).toContain("afade=t=in:st=0:d=0.5");
    expect(filter).toContain("afade=t=out:st=19.500:d=0.5");
    expect(filter).toMatch(/\[0:a\][^;]*asplit=2\[sound\]\[key\]/);
    expect(filter).toMatch(/\[music\]\[key\]sidechaincompress=[^;]*\[ducked\]/);
    expect(filter).toMatch(/\[sound\]\[ducked\]amix=inputs=2:duration=first:normalize=0\[aout\]$/);
  });

  it("uses the music alone for a clip without sound", () => {
    const filter = musicMixFilter({ length: 8, volume: 40, withSound: false });
    expect(filter).not.toContain("[0:a]");
    expect(filter).not.toContain("sidechaincompress");
    expect(filter).toMatch(/volume=0\.40,.*apad=whole_dur=8\.000\[aout\]$/);
  });

  it("throws on a volume out of range and a clip too short to fade", () => {
    expect(() => musicMixFilter({ length: 20, volume: 101, withSound: true })).toThrow("not 0-100");
    expect(() => musicMixFilter({ length: 20, volume: 2.5, withSound: true })).toThrow("not 0-100");
    expect(() => musicMixFilter({ length: 1, volume: 15, withSound: true })).toThrow("too short");
  });
});

// The mean level (dB) of one frequency band of file between from and to seconds, without the other tone.
function bandLevel(file, frequency, from, to) {
  const band = `bandpass=f=${frequency}:width_type=h:w=40`;
  const result = spawnSync(
    "ffmpeg",
    ["-v", "info", "-ss", String(from), "-t", String(to - from), "-i", file, "-af", `${band},${band},${band},volumedetect`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const match = /mean_volume: (-?[\d.]+) dB/.exec(result.stderr);
  if (!match) throw new Error(`no level for ${file}: ${result.stderr.slice(-500)}`);
  return Number(match[1]);
}

describe("mixBackgroundMusic", () => {
  it("turns the music down while someone speaks and keeps the clip's length and picture", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "localirs-music-"));
    try {
      // The "speech": a quiet (-21 dBFS) 1 kHz tone from 3 s to 5 s of a 7 s clip, silence around it.
      const clip = path.join(dir, "clip.mp4");
      execFileSync("ffmpeg", [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=108x192:r=30:d=7",
        "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=7",
        "-filter_complex", "[1:a]volume=volume='if(between(t,3,5),1,0)':eval=frame,aformat=channel_layouts=stereo[a]",
        "-map", "0:v", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        clip,
      ]);
      // The "music": a 2 s, 440 Hz tone, which has to loop to fill the clip.
      const music = path.join(dir, "music.ogg");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2", "-c:a", "libvorbis", music]);

      const output = path.join(dir, "mixed.mp4");
      await mixBackgroundMusic({ input: clip, music, volume: 50, output });

      const probe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", output], { encoding: "utf8" }),
      );
      expect(Math.abs(Number(probe.format.duration) - 7)).toBeLessThan(0.1);
      expect(probe.streams.find((stream) => stream.codec_type === "video").codec_name).toBe("h264");
      expect(probe.streams.find((stream) => stream.codec_type === "audio").codec_name).toBe("aac");

      const before = bandLevel(output, 440, 1, 2.8);
      const during = bandLevel(output, 440, 3.5, 4.8);
      const after = bandLevel(output, 440, 5.8, 6.4);
      // Ducked by well over 10 dB while the speech plays, and back up once it stops (the loop restarts at 2, 4 and 6 s).
      expect(before - during).toBeGreaterThan(10);
      expect(Math.abs(after - before)).toBeLessThan(3);
      // The speech itself is not turned down.
      const speech = bandLevel(output, 1000, 3.5, 4.8);
      const original = bandLevel(clip, 1000, 3.5, 4.8);
      expect(Math.abs(speech - original)).toBeLessThan(1.5);
      // Faded in: the first tenth of a second is far quieter than the music later on.
      expect(before - bandLevel(output, 440, 0, 0.1)).toBeGreaterThan(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives a clip without sound the music as its sound", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "localirs-music-"));
    try {
      const clip = path.join(dir, "silent.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=108x192:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
      const music = path.join(dir, "music.ogg");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-c:a", "libvorbis", music]);
      const output = path.join(dir, "mixed.mp4");
      await mixBackgroundMusic({ input: clip, music, volume: 50, output });
      const probe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", output], { encoding: "utf8" }),
      );
      expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
      expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThan(0.1);
      // At 50 % the music is 6 dB below its own level.
      expect(bandLevel(output, 440, 1, 2) - bandLevel(music, 440, 0.2, 0.8)).toBeCloseTo(-6, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
