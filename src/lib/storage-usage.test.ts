import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { StoredObject } from "./storage";
import { cachedStorage, forgetStorage, measureStorage, projectUsage, storedCategory } from "./storage-usage";

const now = new Date("2026-11-04T12:00:00Z");

function object(key: string, size: number): StoredObject {
  return { key, size, lastModified: now };
}

// Only what measuring and the project list read: the backup settings and the owner's projects.
function fakeDb(projects: Array<Record<string, unknown>> = []) {
  return {
    backupSettings: { findUnique: async () => null },
    clipProject: { findMany: async ({ where }: { where: { ownerId: string } }) => projects.filter((row) => row.ownerId === where.ownerId) },
  } as unknown as PrismaClient;
}

async function write(file: string, bytes: number) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes));
}

let dataDir: string;
let tmpDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "storage-usage-data-"));
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "storage-usage-tmp-"));
  forgetStorage();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tmpDir, { recursive: true, force: true });
});

describe("storedCategory", () => {
  it("sorts keys by what they are", () => {
    expect(storedCategory("clip-sources/p1.mp4")).toBe("sources");
    expect(storedCategory("clips/p1/c1.mp4")).toBe("clips");
    expect(storedCategory("clips/p1/c1.v2.mp4")).toBe("clips");
    expect(storedCategory("clips/p1/c1.base.mp4")).toBe("captionCopies");
    expect(storedCategory("reels/m1.mp4")).toBe("posts");
    expect(storedCategory("youtube/y1.mp4")).toBe("posts");
    expect(storedCategory("slideshow-inputs/a.jpg")).toBe("pictures");
    expect(storedCategory("misc/x")).toBe("other");
  });
});

describe("measureStorage", () => {
  it("sums the stored objects by category and the data folder's engines, backups, logs and temp files", async () => {
    const objects = [
      object("clip-sources/p1.mp4", 1000),
      object("clips/p1/c1.mp4", 200),
      object("clips/p1/c1.v2.mp4", 210),
      object("clips/p1/c1.base.mp4", 150),
      object("raw/m1.mp4", 40),
      object("ai-inputs/a.png", 7),
    ];
    await write(path.join(dataDir, "ai", "ComfyUI", "model.bin"), 5000);
    await write(path.join(dataDir, "ai", "comfyui.log"), 30);
    await write(path.join(dataDir, "slideshow", "script", "model.gguf"), 3000);
    await write(path.join(dataDir, "slideshow", "picture", "sd", "sd-cli"), 400);
    await write(path.join(dataDir, "backups", "localirs-2026-11-01_033000", "localirs.dump"), 600);
    await write(path.join(dataDir, "backups", "notes.txt"), 99);
    await write(path.join(dataDir, "worker.log"), 20);
    await write(path.join(dataDir, "web.err.log"), 5);
    await write(path.join(dataDir, "tmp", "job", "part.bin"), 11);
    await write(path.join(tmpDir, "remotion-webpack-bundle-abc", "bundle.js"), 9);
    await write(path.join(tmpDir, "unrelated", "file"), 1000);

    const usage = await measureStorage({
      db: fakeDb(),
      dataDir,
      tmpDir,
      list: async function* () {
        yield* objects;
      },
      freeSpace: async () => 12345,
      now,
    });

    expect(usage.freeBytes).toBe(12345);
    expect(usage.stored).toEqual({ sources: 1000, clips: 410, captionCopies: 150, posts: 40, pictures: 7, other: 0 });
    expect(usage.aiEngineBytes).toBe(5000);
    expect(usage.slideshowEngineBytes).toEqual({ script: 3000, picture: 400 });
    expect(usage.backupBytes).toBe(600);
    expect(usage.logBytes).toBe(55);
    expect(usage.tempBytes).toBe(20);
  });

  it("measures an empty data folder as nothing", async () => {
    const usage = await measureStorage({ db: fakeDb(), dataDir, tmpDir, list: async function* () {}, freeSpace: async () => 1, now });
    expect(usage.aiEngineBytes + usage.backupBytes + usage.logBytes + usage.tempBytes).toBe(0);
  });

  it("keeps a measurement for a minute unless refreshed", async () => {
    let listed = 0;
    const input = {
      db: fakeDb(),
      dataDir,
      tmpDir,
      list: async function* () {
        listed += 1;
      },
      freeSpace: async () => 1,
    };
    await cachedStorage({ ...input, now });
    await cachedStorage({ ...input, now: new Date(now.getTime() + 59_000) });
    expect(listed).toBe(1);
    await cachedStorage({ ...input, now: new Date(now.getTime() + 61_000) });
    expect(listed).toBe(2);
    await cachedStorage({ ...input, now: new Date(now.getTime() + 62_000), refresh: true });
    expect(listed).toBe(3);
  });
});

describe("projectUsage", () => {
  it("gives each of the owner's projects its source size and the size of all its clip files, largest first", async () => {
    const db = fakeDb([
      { id: "p1", ownerId: "u1", name: "Small", status: "done", sourceKey: "clip-sources/p1.mp4", sourceDeletedAt: null, aiVideos: false, slideshows: false },
      { id: "p2", ownerId: "u1", name: "Big", status: "done", sourceKey: null, sourceDeletedAt: now, aiVideos: false, slideshows: false },
      { id: "p3", ownerId: "u1", name: "AI videos", status: "done", sourceKey: null, sourceDeletedAt: null, aiVideos: true, slideshows: false },
      { id: "p4", ownerId: "u2", name: "Someone else's", status: "done", sourceKey: null, sourceDeletedAt: null, aiVideos: false, slideshows: false },
    ]);
    const objects = [
      object("clip-sources/p1.mp4", 100),
      object("clips/p1/c1.mp4", 10),
      object("clips/p2/c2.mp4", 500),
      object("clips/p2/c2.base.mp4", 300),
      object("clips/p4/c4.mp4", 999),
    ];

    expect(await projectUsage(db, "u1", objects)).toEqual([
      { id: "p2", name: "Big", status: "done", hasSource: true, sourceDeletedAt: now, sourceBytes: 0, clipsBytes: 800 },
      { id: "p1", name: "Small", status: "done", hasSource: true, sourceDeletedAt: null, sourceBytes: 100, clipsBytes: 10 },
      { id: "p3", name: "AI videos", status: "done", hasSource: false, sourceDeletedAt: null, sourceBytes: 0, clipsBytes: 0 },
    ]);
  });
});
