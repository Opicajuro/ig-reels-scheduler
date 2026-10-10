import { describe, expect, it } from "vitest";
import { checkRights, parseAudioSource } from "./rights";

describe("checkRights", () => {
  it("blocks scheduling without confirmation", () => {
    const result = checkRights({ rightsConfirmed: false, audioSource: "original", siblingAccountCount: 0 });
    expect(result.canSchedule).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/confirm/i);
  });

  it("passes without warnings for original audio", () => {
    const result = checkRights({ rightsConfirmed: true, audioSource: "original", siblingAccountCount: 0 });
    expect(result).toEqual({ canSchedule: true, warnings: [] });
  });

  it("warns on audio from the source video but allows scheduling", () => {
    const result = checkRights({ rightsConfirmed: true, audioSource: "from_source", siblingAccountCount: 0 });
    expect(result.canSchedule).toBe(true);
    expect(result.warnings[0]).toMatch(/claim/i);
  });

  it("warns on unknown audio", () => {
    const result = checkRights({ rightsConfirmed: true, audioSource: "unknown", siblingAccountCount: 0 });
    expect(result.canSchedule).toBe(true);
    expect(result.warnings[0]).toMatch(/unknown/i);
  });

  it("warns on duplicates across accounts", () => {
    const result = checkRights({ rightsConfirmed: true, audioSource: "original", siblingAccountCount: 2 });
    expect(result.canSchedule).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("2 other account"))).toBe(true);
  });
});

describe("parseAudioSource", () => {
  it("accepts the known values", () => {
    expect(parseAudioSource("original")).toBe("original");
    expect(parseAudioSource("licensed")).toBe("licensed");
    expect(parseAudioSource("from_source")).toBe("from_source");
  });

  it("falls back to unknown for anything else", () => {
    expect(parseAudioSource("")).toBe("unknown");
    expect(parseAudioSource(null)).toBe("unknown");
    expect(parseAudioSource("evil")).toBe("unknown");
  });
});
