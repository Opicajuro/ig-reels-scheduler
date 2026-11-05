import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mixSoundEffects, soundEffectsFilter } from "./sound-effects.js";

describe("soundEffectsFilter", () => {
  it("delays each sound to its time at its volume, sums them over the clip's sound and limits the peaks", () => {
    // A hook whoosh at 0 s and caption pops at 1.2 s and 3.5 s (automatic), and a hand-placed sound at 7.25 s.
    const filter = soundEffectsFilter({
      length: 10,
      files: ["whoosh.ogg", "pop.ogg", "coin.ogg"],
      sounds: [
        { file: 0, time: 0, volume: 80 },
        { file: 1, time: 1.2, volume: 25 },
        { file: 1, time: 3.5, volume: 25 },
        { file: 2, time: 7.25, volume: 60 },
      ],
      withSound: true,
    });
    // One input per file, split into a copy per use.
    expect(filter).toMatch(/\[1:a\][^;]*asplit=1\[f0\]/);
    expect(filter).toMatch(/\[2:a\][^;]*asplit=2\[f1\]\[f2\]/);
    expect(filter).toMatch(/\[3:a\][^;]*asplit=1\[f3\]/);
    expect(filter).toContain("[f0]volume=0.80,adelay=0:all=1[s0]");
    expect(filter).toContain("[f1]volume=0.25,adelay=1200:all=1[s1]");
    expect(filter).toContain("[f2]volume=0.25,adelay=3500:all=1[s2]");
    expect(filter).toContain("[f3]volume=0.60,adelay=7250:all=1[s3]");
    // The clip's own sound is padded to its length and is not ducked.
    expect(filter).toMatch(/\[0:a\][^;]*apad=whole_dur=10\.000\[base\]/);
    expect(filter).not.toContain("sidechaincompress");
    expect(filter).toMatch(
      /\[base\]\[s0\]\[s1\]\[s2\]\[s3\]amix=inputs=5:duration=first:normalize=0,alimiter=limit=0\.95:level=0:latency=1\[aout\]$/,
    );
  });

  it("plays the sounds over silence for a clip without sound", () => {
    const filter = soundEffectsFilter({ length: 4, files: ["pop.ogg"], sounds: [{ file: 0, time: 2, volume: 50 }], withSound: false });
    expect(filter).not.toContain("[0:a]");
    expect(filter).toContain("anullsrc=channel_layout=stereo:sample_rate=48000:duration=4.000");
    expect(filter).toMatch(/\[base\]\[s0\]amix=inputs=2:duration=first:normalize=0/);
  });

  it("throws on a sound outside the clip, a bad volume or file, and no sounds", () => {
    const files = ["pop.ogg"];
    const at = (time, volume = 50, file = 0) => ({ length: 5, files, sounds: [{ file, time, volume }], withSound: true });
    expect(() => soundEffectsFilter(at(5))).toThrow("outside the 5s clip");
    expect(() => soundEffectsFilter(at(-0.1))).toThrow("outside");
    expect(() => soundEffectsFilter(at(1, 101))).toThrow("not 0-100");
    expect(() => soundEffectsFilter(at(1, 50, 1))).toThrow("has no file");
    expect(() => soundEffectsFilter({ length: 5, files, sounds: [], withSound: true })).toThrow("no sound effects");
    expect(() =>
      soundEffectsFilter({ length: 5, files: ["a.ogg", "b.ogg"], sounds: [{ file: 0, time: 1, volume: 50 }], withSound: true }),
    ).toThrow("is not used");
  });
});

// The mean level (dB) of one frequency band of file between from and to seconds.
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

function probeLength(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));
}

function peakLevel(file) {
  const result = spawnSync("ffmpeg", ["-v", "info", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const match = /max_volume: (-?[\d.]+) dB/.exec(result.stderr);
  if (!match) throw new Error(`no peak for ${file}`);
  return Number(match[1]);
}

describe("mixSoundEffects", () => {
  it("puts the sound at its time over the clip's sound and keeps the length and picture", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "localirs-sfx-"));
    try {
      // A 6 s clip whose sound is a 440 Hz tone all through.
      const clip = path.join(dir, "clip.mp4");
      execFileSync("ffmpeg", [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=108x192:r=30:d=6",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
        "-filter_complex", "[1:a]volume=1.4,aformat=channel_layouts=stereo[a]",
        "-map", "0:v", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        clip,
      ]);
      // The sound effect: a 0.3 s, 2 kHz beep.
      const beep = path.join(dir, "beep.ogg");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=2000:sample_rate=44100:duration=0.3", "-af", "volume=1.4", "-c:a", "libvorbis", beep]);

      const output = path.join(dir, "sounds.mp4");
      await mixSoundEffects({ input: clip, sounds: [{ file: beep, time: 3, volume: 100 }], output });

      const probe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", output], { encoding: "utf8" }),
      );
      expect(Math.abs(Number(probe.format.duration) - 6)).toBeLessThan(0.1);
      expect(probe.streams.find((stream) => stream.codec_type === "video").codec_name).toBe("h264");

      // The beep sounds from 3 s to 3.3 s and nowhere else.
      const during = bandLevel(output, 2000, 3.05, 3.25);
      expect(during - bandLevel(output, 2000, 1, 2.8)).toBeGreaterThan(30);
      expect(during - bandLevel(output, 2000, 3.6, 5.5)).toBeGreaterThan(30);
      // The clip's own sound is not turned down while it plays.
      expect(Math.abs(bandLevel(output, 440, 3.05, 3.25) - bandLevel(clip, 440, 3.05, 3.25))).toBeLessThan(1.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never clips: a loud sound over loud speech is held under full scale", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "localirs-sfx-"));
    try {
      // Both at about -1 dBFS: summed, they would reach +5 dBFS.
      const clip = path.join(dir, "clip.mp4");
      execFileSync("ffmpeg", [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=blue:s=108x192:r=30:d=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-filter_complex", "[1:a]volume=10,aformat=channel_layouts=stereo[a]",
        "-map", "0:v", "-map", "[a]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
        clip,
      ]);
      const beep = path.join(dir, "beep.ogg");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=2000:sample_rate=48000:duration=1", "-af", "volume=10", "-c:a", "libvorbis", beep]);
      const output = path.join(dir, "sounds.mp4");
      await mixSoundEffects({ input: clip, sounds: [{ file: beep, time: 1.5, volume: 100 }], output });
      expect(peakLevel(clip)).toBeGreaterThan(-2);
      expect(peakLevel(output)).toBeLessThan(0);
      expect(Math.abs((await probeLength(output)) - 4)).toBeLessThan(0.1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives a clip without sound the sounds as its sound", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "localirs-sfx-"));
    try {
      const clip = path.join(dir, "silent.mp4");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=108x192:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
      const beep = path.join(dir, "beep.ogg");
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=2000:duration=0.2", "-c:a", "libvorbis", beep]);
      const output = path.join(dir, "sounds.mp4");
      await mixSoundEffects({ input: clip, sounds: [{ file: beep, time: 1, volume: 50 }], output });
      const probe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", output], { encoding: "utf8" }),
      );
      expect(probe.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
      expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThan(0.1);
      expect(bandLevel(output, 2000, 1.02, 1.18) - bandLevel(output, 2000, 2, 2.8)).toBeGreaterThan(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
