import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ClipStore } from "./clip-store";
import type { StoredObject } from "./storage";
import {
  cleanTemp,
  findOrphans,
  LOG_KEEP_BYTES,
  parseBaseCutDays,
  planBackups,
  planBaseCuts,
  planLogs,
  planTemp,
  removeBaseCuts,
  removeOldBackups,
  removeOrphans,
  trimLogs,
} from "./storage-cleanup";

type Row = Record<string, unknown> & { id: string };

const now = new Date("2026-11-04T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

// Enough of Prisma for the clean-ups: equality, { in }, { not: null } and { lt } filters.
function fakeDb(seed: Partial<Record<"media" | "ytPost" | "clipProject" | "clip" | "aiVideoJob" | "slideshowJob" | "backup", Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    media: [],
    ytPost: [],
    clipProject: [],
    clip: [],
    aiVideoJob: [],
    slideshowJob: [],
    backup: [],
    ...seed,
  };
  const matches = (row: Row, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === "object" && !(value instanceof Date)) {
        const filter = value as { in?: unknown[]; not?: unknown; lt?: Date };
        if (filter.in) return filter.in.includes(row[key]);
        if ("not" in filter) return row[key] !== filter.not;
        if (filter.lt) return (row[key] as Date) < filter.lt;
      }
      return row[key] === value;
    });
  const model = (table: string) => ({
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => tables[table].filter((row) => matches(row, where)),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const rows = tables[table].filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data);
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const before = tables[table].length;
      tables[table] = tables[table].filter((row) => !matches(row, where));
      return { count: before - tables[table].length };
    },
  });
  const db = {
    ...Object.fromEntries(Object.keys(tables).map((table) => [table, model(table)])),
    backupSettings: { findUnique: async () => null },
  } as unknown as PrismaClient;
  return { db, tables };
}

function fakeStore() {
  const removed: string[] = [];
  const store: ClipStore = {
    downloadTo: async () => {},
    upload: async () => {},
    copy: async () => {},
    remove: async (key) => void removed.push(key),
  };
  return { store, removed };
}

function object(key: string, size: number, lastModified = hoursAgo(48)): StoredObject {
  return { key, size, lastModified };
}

let dataDir: string;
let tmpDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "storage-cleanup-data-"));
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "storage-cleanup-tmp-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(tmpDir, { recursive: true, force: true });
});

async function write(file: string, content: string | Buffer, modified?: Date) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  if (modified) await utimes(file, modified, modified);
}

describe("orphaned files", () => {
  const referenced = () =>
    fakeDb({
      media: [{ id: "m1", rawKey: "raw/m1.mp4", reelKey: "reels/m1.mp4", coverKey: null }],
      ytPost: [{ id: "y1", videoKey: "youtube/y1.mp4" }],
      clipProject: [{ id: "p1", sourceKey: "clip-sources/p1.mp4" }],
      clip: [{ id: "c1", storageKey: "clips/p1/c1.v2.mp4", baseKey: "clips/p1/c1.base.mp4" }],
      aiVideoJob: [{ id: "a1", startImageKey: "ai-inputs/a1.png" }],
      slideshowJob: [
        { id: "s1", slides: [{ source: { kind: "photo", key: "slideshow-inputs/s1.jpg" } }, { source: { kind: "ai" } }] },
        { id: "s2", slides: null },
      ],
    });

  it("finds stored files no row points at, keeping every referenced key", async () => {
    const { db } = referenced();
    const kept = [
      "raw/m1.mp4",
      "reels/m1.mp4",
      "youtube/y1.mp4",
      "clip-sources/p1.mp4",
      "clips/p1/c1.v2.mp4",
      "clips/p1/c1.base.mp4",
      "ai-inputs/a1.png",
      "slideshow-inputs/s1.jpg",
    ].map((key) => object(key, 10));
    const orphans = [object("clips/p1/c1.mp4", 300), object("clip-sources/deleted.mp4", 900)];

    expect(await findOrphans({ db, objects: [...kept, ...orphans], now })).toEqual(orphans);
  });

  it("leaves files younger than a day, which may be uploads or clips whose rows are not written yet", async () => {
    const { db } = referenced();
    const fresh = object("clips/p1/new.mp4", 50, hoursAgo(23));
    const old = object("clips/p1/old.mp4", 70, hoursAgo(24));
    expect(await findOrphans({ db, objects: [fresh, old], now })).toEqual([old]);
  });

  it("removes them and says what it freed", async () => {
    const { db } = referenced();
    const files = fakeStore();
    const result = await removeOrphans({
      db,
      store: files.store,
      objects: [object("clips/p1/c1.mp4", 300), object("clips/p1/c1.v2.mp4", 310), object("x/fresh", 5, hoursAgo(1))],
      now,
    });
    expect(result).toEqual({ count: 1, bytes: 300 });
    expect(files.removed).toEqual(["clips/p1/c1.mp4"]);
  });
});

describe("caption-edit copies", () => {
  const seed = () =>
    fakeDb({
      clip: [
        { id: "old", baseKey: "clips/p1/old.base.mp4", words: [], recaptionId: null, createdAt: hoursAgo(24 * 31) },
        { id: "new", baseKey: "clips/p1/new.base.mp4", words: [], recaptionId: null, createdAt: hoursAgo(24 * 29) },
        { id: "busy", baseKey: "clips/p1/busy.base.mp4", words: [], recaptionId: "r1", createdAt: hoursAgo(24 * 40) },
        { id: "plain", baseKey: null, words: null, recaptionId: null, createdAt: hoursAgo(24 * 40) },
      ],
    });
  const objects = [object("clips/p1/old.base.mp4", 400), object("clips/p1/new.base.mp4", 500), object("clips/p1/busy.base.mp4", 600)];

  it("plans and removes the copies of clips older than the days given, not one being drawn again, keeping the words", async () => {
    const { db, tables } = seed();
    expect(await planBaseCuts({ db, objects, days: 30, now })).toEqual({ count: 1, bytes: 400 });
    const files = fakeStore();

    expect(await removeBaseCuts({ db, store: files.store, objects, days: 30, now })).toEqual({ count: 1, bytes: 400 });
    expect(files.removed).toEqual(["clips/p1/old.base.mp4"]);
    expect(tables.clip.find((clip) => clip.id === "old")).toMatchObject({ baseKey: null, words: [] });
    expect(tables.clip.find((clip) => clip.id === "new")!.baseKey).toBe("clips/p1/new.base.mp4");
    expect(tables.clip.find((clip) => clip.id === "busy")!.baseKey).toBe("clips/p1/busy.base.mp4");

    expect(await planBaseCuts({ db, objects, days: 1, now })).toEqual({ count: 1, bytes: 500 });
  });

  it("takes a whole number of days", () => {
    expect(parseBaseCutDays("30")).toBe(30);
    expect(() => parseBaseCutDays("0")).toThrow("whole number");
    expect(() => parseBaseCutDays("2.5")).toThrow("whole number");
  });
});

describe("old backups", () => {
  it("keeps the newest 3 backups and anything else in the folder", async () => {
    const names = ["localirs-2026-11-01_033000", "localirs-2026-11-02_033000", "localirs-2026-11-03_033000", "localirs-2026-11-04_033000", "localirs-2026-10-31_033000"];
    for (const name of names) await write(path.join(dataDir, "backups", name, "localirs.dump"), Buffer.alloc(100));
    await write(path.join(dataDir, "backups", "my-notes.txt"), "keep");
    const { db, tables } = fakeDb({
      backup: names.map((name, index) => ({ id: `b${index}`, path: path.join(dataDir, "backups", name) })),
    });

    expect(await planBackups({ db, dataDir })).toEqual({ count: 2, bytes: 200 });
    expect(await removeOldBackups({ db, dataDir })).toEqual({ count: 2, bytes: 200 });
    expect((await readdir(path.join(dataDir, "backups"))).sort()).toEqual([
      "localirs-2026-11-02_033000",
      "localirs-2026-11-03_033000",
      "localirs-2026-11-04_033000",
      "my-notes.txt",
    ]);
    expect(tables.backup.map((row) => row.id).sort()).toEqual(["b1", "b2", "b3"]);
  });

  it("has nothing to do before the first backup", async () => {
    expect(await planBackups({ db: fakeDb().db, dataDir })).toEqual({ count: 0, bytes: 0 });
  });
});

describe("logs", () => {
  it("cuts each log over 10 MB to its last 1 MB from a full line, leaving smaller ones", async () => {
    const line = "2026-11-04 worker: made a clip\n";
    const big = line.repeat(Math.ceil((11 * 1024 * 1024) / line.length));
    await write(path.join(dataDir, "worker.log"), big);
    await write(path.join(dataDir, "ai", "comfyui.log"), big);
    await write(path.join(dataDir, "web.log"), "small\n");

    const plan = await planLogs({ dataDir });
    expect(plan.count).toBe(2);
    expect(plan.bytes).toBe(2 * (big.length - LOG_KEEP_BYTES));

    const result = await trimLogs({ dataDir });
    expect(result.count).toBe(2);
    expect(result.inUse).toEqual([]);
    const trimmed = await readFile(path.join(dataDir, "worker.log"), "utf8");
    expect(trimmed.length).toBeLessThanOrEqual(LOG_KEEP_BYTES);
    expect(trimmed.length).toBeGreaterThan(LOG_KEEP_BYTES - line.length);
    expect(trimmed.startsWith(line)).toBe(true);
    expect(big.endsWith(trimmed)).toBe(true);
    expect(result.bytes).toBe(2 * (big.length - trimmed.length));
    expect(await readFile(path.join(dataDir, "web.log"), "utf8")).toBe("small\n");
    expect(await planLogs({ dataDir })).toEqual({ count: 0, bytes: 0 });
  });
});

describe("temporary files", () => {
  it("removes <data>\\tmp entries and Remotion bundles untouched for an hour, leaving newer ones and other temp files", async () => {
    const realNow = new Date();
    const old = new Date(realNow.getTime() - 2 * 60 * 60 * 1000);
    await write(path.join(dataDir, "tmp", "old.bin"), Buffer.alloc(30), old);
    await write(path.join(dataDir, "tmp", "new.bin"), Buffer.alloc(40));
    await write(path.join(tmpDir, "remotion-webpack-bundle-old", "bundle.js"), Buffer.alloc(50));
    await utimes(path.join(tmpDir, "remotion-webpack-bundle-old"), old, old);
    await write(path.join(tmpDir, "remotion-webpack-bundle-new", "bundle.js"), Buffer.alloc(60));
    await write(path.join(tmpDir, "clip-project-old", "source.mp4"), Buffer.alloc(70));
    await utimes(path.join(tmpDir, "clip-project-old"), old, old);

    expect(await planTemp({ dataDir, tmpDir, now: realNow })).toEqual({ count: 2, bytes: 80 });
    expect(await cleanTemp({ dataDir, tmpDir, now: realNow })).toEqual({ count: 2, bytes: 80 });
    expect(await readdir(path.join(dataDir, "tmp"))).toEqual(["new.bin"]);
    expect((await readdir(tmpDir)).sort()).toEqual(["clip-project-old", "remotion-webpack-bundle-new"]);
  });

  it("has nothing to do without a tmp folder", async () => {
    expect(await planTemp({ dataDir, tmpDir, now })).toEqual({ count: 0, bytes: 0 });
    await expect(stat(path.join(dataDir, "tmp"))).rejects.toThrow();
  });
});
