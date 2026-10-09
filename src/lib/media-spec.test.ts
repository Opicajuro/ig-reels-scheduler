import { describe, expect, it } from "vitest";
import { buildReelTranscodeArgs, checkReelSpec } from "./media-spec";

const GOOD_PROBE = {
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "30.0" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
  ],
};

describe("buildReelTranscodeArgs", () => {
  it("uses the exact transcode command from the handoff", () => {
    expect(buildReelTranscodeArgs("in.mkv", "out.mp4")).toEqual([
      "-y",
      "-i", "in.mkv",
      "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
      "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20",
      "-maxrate", "8M", "-bufsize", "16M", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
      "out.mp4",
    ]);
  });
});

describe("checkReelSpec", () => {
  it("accepts a conforming Reel", () => {
    expect(checkReelSpec(GOOD_PROBE)).toEqual([]);
  });

  it("reports the no audio stream error when the source has no audio", () => {
    const probe = { ...GOOD_PROBE, streams: [GOOD_PROBE.streams[0]] };
    expect(checkReelSpec(probe)).toContain("no audio stream");
  });

  it("reports a wrong resolution", () => {
    const probe = {
      ...GOOD_PROBE,
      streams: [{ ...GOOD_PROBE.streams[0], width: 1920, height: 1080 }, GOOD_PROBE.streams[1]],
    };
    expect(checkReelSpec(probe)).toContain("resolution must be 1080x1920");
  });

  it("reports a duration outside 3 seconds to 15 minutes", () => {
    expect(checkReelSpec({ ...GOOD_PROBE, format: { ...GOOD_PROBE.format, duration: "2" } })).toContain(
      "duration must be between 3 and 900 seconds",
    );
  });

  it("reports a frame rate outside 23 to 60 fps", () => {
    const probe = {
      ...GOOD_PROBE,
      streams: [{ ...GOOD_PROBE.streams[0], r_frame_rate: "15/1" }, GOOD_PROBE.streams[1]],
    };
    expect(checkReelSpec(probe)).toContain("frame rate must be between 23 and 60 fps");
  });

  it("reports a container that is not MP4 or MOV", () => {
    expect(checkReelSpec({ ...GOOD_PROBE, format: { ...GOOD_PROBE.format, format_name: "matroska,webm" } })).toContain(
      "container must be MP4 or MOV",
    );
  });
});
