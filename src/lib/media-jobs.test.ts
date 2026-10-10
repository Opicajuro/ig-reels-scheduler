import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { processMedia } from "./media-jobs";

function makeFixture(withAudio: boolean): Buffer {
  const dir = mkdtempSync(path.join(os.tmpdir(), "media-job-test-"));
  const file = path.join(dir, "raw.mp4");
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=4:size=640x360:rate=25"];
  if (withAudio) args.push("-f", "lavfi", "-i", "sine=duration=4");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(file);
  execFileSync("ffmpeg", args);
  return readFileSync(file);
}

function fakeDb(media: Record<string, unknown>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    media: {
      findUnique: async () => media,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      },
    },
  };
  return { db: db as unknown as PrismaClient, updates };
}

function fakeStorage(raw: Buffer) {
  const uploads: Array<{ key: string; bytes: number; contentType: string }> = [];
  const downloadedTo: string[] = [];
  return {
    uploads,
    downloadedTo,
    downloadToFile: async (_key: string, filePath: string) => {
      downloadedTo.push(filePath);
      writeFileSync(filePath, raw);
    },
    uploadFromFile: async (key: string, filePath: string, contentType: string) => {
      uploads.push({ key, bytes: statSync(filePath).size, contentType });
    },
  };
}

const MEDIA = { id: "media-1", rawKey: "raw/media-1.mp4", status: "uploaded" };

describe("processMedia", () => {
  it("transcodes the raw upload and marks the media ready with its Reel", async () => {
    const storage = fakeStorage(makeFixture(true));
    const { db, updates } = fakeDb(MEDIA);

    await processMedia({ db, mediaId: "media-1", ...storage });

    expect(storage.uploads).toEqual([
      expect.objectContaining({ key: "reels/media-1.mp4", contentType: "video/mp4" }),
    ]);
    // The work folder with the raw and transcoded video is removed once the job ends.
    expect(existsSync(path.dirname(storage.downloadedTo[0]))).toBe(false);
    expect(storage.uploads[0].bytes).toBeGreaterThan(0);
    expect(updates.at(-1)).toMatchObject({
      status: "ready",
      reelKey: "reels/media-1.mp4",
      width: 1080,
      height: 1920,
      error: null,
    });
  }, 60_000);

  it("marks the media failed with the reason when the source has no audio", async () => {
    const storage = fakeStorage(makeFixture(false));
    const { db, updates } = fakeDb(MEDIA);

    await processMedia({ db, mediaId: "media-1", ...storage });

    expect(storage.uploads).toEqual([]);
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
    expect(String(updates.at(-1)?.error)).toContain("no audio stream");
    expect(existsSync(path.dirname(storage.downloadedTo[0]))).toBe(false);
  }, 60_000);

  it("does nothing when the media is already ready", async () => {
    const storage = fakeStorage(makeFixture(true));
    const { db, updates } = fakeDb({ ...MEDIA, status: "ready" });

    await processMedia({ db, mediaId: "media-1", ...storage });

    expect(updates).toEqual([]);
  });
});
