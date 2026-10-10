import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClipStore } from "./clip-store";
import { buildPostingSheet, planPostTimes, writePostingZip, zipFileName } from "./clip-export";

const HOUR = 60 * 60 * 1000;

describe("planPostTimes", () => {
  it("spaces the clips evenly from the first time", () => {
    const first = new Date("2026-10-11T18:00:00Z");
    expect(planPostTimes(first, 24, 3)).toEqual([
      new Date("2026-10-11T18:00:00Z"),
      new Date(first.getTime() + 24 * HOUR),
      new Date(first.getTime() + 48 * HOUR),
    ]);
  });
});

describe("zipFileName", () => {
  it("keeps the name plain so it cannot change folders", () => {
    expect(zipFileName(0, "../etc/Best moment")).toBe("1-.._etc_Best moment.mp4");
  });
});

describe("buildPostingSheet", () => {
  it("lists each clip with its post time, title and description, in order", () => {
    const sheet = buildPostingSheet(
      "Grocery store challenge",
      [
        { name: "clip-001", storageKey: "a", title: "Price check", description: "Line one #shorts", postAt: new Date("2026-10-11T18:00:00Z") },
        { name: "clip-002", storageKey: "b", title: null, description: null, postAt: new Date("2026-10-12T18:00:00Z") },
      ],
      "UTC",
    );
    expect(sheet).toContain("Posting sheet: Grocery store challenge");
    expect(sheet).toContain("1. 1-clip-001.mp4\nPost at: ");
    expect(sheet).toContain("Title: Price check\nDescription:\nLine one #shorts");
    expect(sheet).toContain("2. 2-clip-002.mp4\nPost at: ");
    expect(sheet).toContain("Title: clip-002\nDescription:\n");
    expect(sheet.indexOf("1. 1-clip-001")).toBeLessThan(sheet.indexOf("2. 2-clip-002"));
  });
});

describe("writePostingZip", () => {
  let work: string;
  let bucket: string;

  beforeAll(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "posting-zip-test-"));
    bucket = path.join(work, "bucket");
    await mkdir(path.join(bucket, "clips", "p1"), { recursive: true });
    const clipPath = path.join(work, "source.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=10", "-pix_fmt", "yuv420p", clipPath]);
    await copyFile(clipPath, path.join(bucket, "clips", "p1", "c1.mp4"));
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("writes a ZIP with each clip and the posting sheet", async () => {
    const store: ClipStore = {
      downloadTo: async (key, filePath) => copyFile(path.join(bucket, key), filePath),
      upload: async () => {},
      copy: async () => {},
      remove: async () => {},
    };
    const out = await mkdtemp(path.join(work, "run-"));
    const zipPath = await writePostingZip({
      store,
      workDir: out,
      projectName: "Test",
      timeZone: "UTC",
      items: [{ name: "Best moment", storageKey: "clips/p1/c1.mp4", title: "Hi", description: "Text", postAt: new Date("2026-10-11T18:00:00Z") }],
    });

    const bytes = await readFile(zipPath);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    const names = bytes.toString("latin1");
    expect(names).toContain("1-Best moment.mp4");
    expect(names).toContain("posting-sheet.txt");
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
