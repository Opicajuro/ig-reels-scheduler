import { describe, expect, it } from "vitest";
import { buildUploadSheet, uploadDetails } from "./upload-sheet";

describe("uploadDetails", () => {
  it("falls back to the clip name when no title is saved", () => {
    expect(uploadDetails({ name: "Best moment", title: null, description: null })).toEqual({
      title: "Best moment",
      description: "",
    });
  });

  it("uses the saved title and description", () => {
    expect(uploadDetails({ name: "clip-002", title: "Nobody expected this", description: "Wait for it #shorts" })).toEqual({
      title: "Nobody expected this",
      description: "Wait for it #shorts",
    });
  });
});

describe("buildUploadSheet", () => {
  it("lists each clip with its title and description in order", () => {
    const sheet = buildUploadSheet("Grocery store challenge", [
      { name: "clip-001", title: "Price check", description: "Line one\nLine two #shorts" },
      { name: "clip-002", title: null, description: null },
    ]);

    expect(sheet).toBe(
      [
        "Upload sheet: Grocery store challenge",
        "",
        "Upload each clip in YouTube Studio (Create > Upload videos), then paste its title and description.",
        "",
        "1. clip-001.mp4",
        "Title: Price check",
        "Description:",
        "Line one\nLine two #shorts",
        "",
        "2. clip-002.mp4",
        "Title: clip-002",
        "Description:",
        "",
      ].join("\n"),
    );
  });
});
