import { describe, expect, it } from "vitest";
import { AUTO_SOUNDS, automaticSounds, isSoundEffect, parseAutoSound, parseClipSounds, SOUND_EFFECTS } from "./clip-sounds";
import { UserError } from "./user-error";

describe("sound effects", () => {
  it("are the library's 16 sound effects, and the automatic sounds start with three of them", () => {
    expect(SOUND_EFFECTS).toHaveLength(16);
    for (const auto of Object.values(AUTO_SOUNDS)) expect(isSoundEffect(auto.sound)).toBe(true);
    expect(isSoundEffect("km-tyrant")).toBe(false);
  });
});

describe("parseAutoSound", () => {
  it("keeps a sound effect, null for off, and refuses music and unknown ids", () => {
    expect(parseAutoSound(null)).toBeNull();
    expect(parseAutoSound("kenney-coin")).toBe("kenney-coin");
    expect(() => parseAutoSound("km-tyrant")).toThrow(UserError);
    expect(() => parseAutoSound("")).toThrow('unknown sound effect ""');
  });
});

describe("parseClipSounds", () => {
  it("sorts the sounds by time and rounds the times to hundredths", () => {
    expect(
      parseClipSounds(
        [
          { time: 4.256, sound: "kenney-coin", volume: 60 },
          { time: 0, sound: "kenney-jump", volume: 0 },
        ],
        10,
      ),
    ).toEqual([
      { time: 0, sound: "kenney-jump", volume: 0 },
      { time: 4.26, sound: "kenney-coin", volume: 60 },
    ]);
  });

  it("refuses sounds outside the clip, unknown sounds, bad volumes and too many", () => {
    const one = (sound: Record<string, unknown>) => () => parseClipSounds([{ time: 1, sound: "kenney-coin", volume: 50, ...sound }], 10);
    expect(one({ time: 10 })).toThrow("inside the clip's 10.0 seconds");
    expect(one({ time: -1 })).toThrow("inside the clip");
    expect(one({ time: "1" })).toThrow("inside the clip");
    expect(one({ sound: "km-tyrant" })).toThrow("not a known sound effect");
    expect(one({ volume: 101 })).toThrow("0 to 100");
    expect(one({ volume: 5.5 })).toThrow("0 to 100");
    expect(() => parseClipSounds({}, 10)).toThrow("not a list");
    expect(() => parseClipSounds(Array.from({ length: 51 }, () => ({ time: 1, sound: "kenney-coin", volume: 5 })), 10)).toThrow(
      "at most 50",
    );
  });
});

describe("automaticSounds", () => {
  const all = { sfxHook: "kenney-weapon-change", sfxCaptions: "kenney-placement", sfxCuts: "kenney-tile-swap" };

  it("adds the whoosh at 0 s with a hook, a pop at each caption line and a tick at each cut", () => {
    expect(automaticSounds({ project: all, hook: true, lineStarts: [0.5, 2], cuts: [1.4] })).toEqual([
      { time: 0, sound: "kenney-weapon-change", volume: AUTO_SOUNDS.hook.volume },
      { time: 0.5, sound: "kenney-placement", volume: AUTO_SOUNDS.captions.volume },
      { time: 2, sound: "kenney-placement", volume: AUTO_SOUNDS.captions.volume },
      { time: 1.4, sound: "kenney-tile-swap", volume: AUTO_SOUNDS.cuts.volume },
    ]);
  });

  it("adds no whoosh without a hook title, and nothing for the sounds that are off", () => {
    expect(automaticSounds({ project: all, hook: false, lineStarts: [], cuts: [] })).toEqual([]);
    expect(
      automaticSounds({ project: { sfxHook: null, sfxCaptions: null, sfxCuts: null }, hook: true, lineStarts: [1], cuts: [2] }),
    ).toEqual([]);
  });
});
