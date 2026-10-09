import { describe, expect, it } from "vitest";
import { validateCaption } from "./caption";

describe("validateCaption", () => {
  it("accepts a normal caption", () => {
    expect(validateCaption("Big win tonight! #gaming @friend")).toEqual([]);
  });

  it("rejects a caption over 2,200 characters", () => {
    expect(validateCaption("a".repeat(2201))).toContain("caption must be at most 2200 characters");
  });

  it("accepts exactly 2,200 characters", () => {
    expect(validateCaption("a".repeat(2200))).toEqual([]);
  });

  it("rejects more than 30 hashtags", () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    expect(validateCaption(caption)).toContain("caption may have at most 30 hashtags");
  });

  it("rejects more than 20 mentions", () => {
    const caption = Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" ");
    expect(validateCaption(caption)).toContain("caption may have at most 20 mentions");
  });

  it("counts hashtags and mentions separately, not as words", () => {
    expect(validateCaption("#a #b @c")).toEqual([]);
  });
});
