import { open, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ClipStore } from "./clip-store";
import { backupFolders, diskBytes, exists, logFiles, remotionBundles, tempFolder } from "./storage-usage";
import type { StoredObject } from "./storage";
import { UserError } from "./user-error";
import { photoKeys } from "./work-cleanup";

// The Storage page's clean-ups. Each has a plan, what it would delete and the bytes that frees, shown in its
// confirmation, and a run that measures again and deletes.
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BASE_CUT_DAYS = 30;
export const KEEP_NEWEST_BACKUPS = 3;
export const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP_BYTES = 1024 * 1024;
export const TEMP_MIN_AGE_MS = 60 * 60 * 1000;

export type Plan = { count: number; bytes: number };

function total(sizes: number[]): Plan {
  return { count: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
}

// Every storage key a database row points at: posts' videos, projects' sources, clips and their caption-edit copies,
// AI videos' start pictures and slideshows' photos.
export async function referencedKeys(db: PrismaClient): Promise<Set<string>> {
  const [media, ytPosts, projects, clips, videos, shows] = await Promise.all([
    db.media.findMany({ select: { rawKey: true, reelKey: true, coverKey: true } }),
    db.ytPost.findMany({ select: { videoKey: true } }),
    db.clipProject.findMany({ select: { sourceKey: true } }),
    db.clip.findMany({ select: { storageKey: true, baseKey: true } }),
    db.aiVideoJob.findMany({ select: { startImageKey: true } }),
    db.slideshowJob.findMany({ select: { slides: true } }),
  ]);
  const keys = [
    ...media.flatMap((row) => [row.rawKey, row.reelKey, row.coverKey]),
    ...ytPosts.map((row) => row.videoKey),
    ...projects.map((row) => row.sourceKey),
    ...clips.flatMap((row) => [row.storageKey, row.baseKey]),
    ...videos.map((row) => row.startImageKey),
    ...shows.flatMap((row) => photoKeys(row.slides)),
  ];
  return new Set(keys.filter((key): key is string => key !== null));
}

// Stored objects no row points at, such as a clip's versions before its last re-render. Only those older than a day:
// a file being uploaded or a clip being made is stored before its row is written.
export async function findOrphans({ db, objects, now }: { db: PrismaClient; objects: StoredObject[]; now: Date }): Promise<StoredObject[]> {
  const referenced = await referencedKeys(db);
  return objects.filter((item) => !referenced.has(item.key) && now.getTime() - item.lastModified.getTime() >= ORPHAN_MIN_AGE_MS);
}

export async function removeOrphans(input: { db: PrismaClient; store: ClipStore; objects: StoredObject[]; now: Date }): Promise<Plan> {
  const orphans = await findOrphans(input);
  for (const item of orphans) await input.store.remove(item.key);
  return total(orphans.map((item) => item.size));
}

export function parseBaseCutDays(value: unknown): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new UserError("the number of days must be a whole number from 1 to 3650");
  return days;
}

// Clips made more than `days` ago that keep an uncaptioned cut for caption editing. Not one whose captions are being
// drawn again from it.
async function oldBaseCuts(db: PrismaClient, days: number, now: Date) {
  return db.clip.findMany({
    where: { baseKey: { not: null }, recaptionId: null, createdAt: { lt: new Date(now.getTime() - days * 24 * 60 * 60 * 1000) } },
    select: { id: true, baseKey: true },
  });
}

export async function planBaseCuts({ db, objects, days, now }: { db: PrismaClient; objects: StoredObject[]; days: number; now: Date }): Promise<Plan> {
  const sizes = new Map(objects.map((item) => [item.key, item.size]));
  return total((await oldBaseCuts(db, days, now)).map((clip) => sizes.get(clip.baseKey!) ?? 0));
}

// The clip keeps its words, which with no cut tell the Captions tab why it cannot edit them. The row changes first,
// guarded on the re-render not having started meanwhile; a file left by a failed delete is an orphan.
export async function removeBaseCuts({
  db,
  store,
  objects,
  days,
  now,
}: {
  db: PrismaClient;
  store: ClipStore;
  objects: StoredObject[];
  days: number;
  now: Date;
}): Promise<Plan> {
  const sizes = new Map(objects.map((item) => [item.key, item.size]));
  const removed: number[] = [];
  for (const { id, baseKey } of await oldBaseCuts(db, days, now)) {
    const { count } = await db.clip.updateMany({ where: { id, baseKey, recaptionId: null }, data: { baseKey: null } });
    if (count === 0) continue;
    await store.remove(baseKey!);
    removed.push(sizes.get(baseKey!) ?? 0);
  }
  return total(removed);
}

async function oldBackups(db: PrismaClient, dataDir: string): Promise<string[]> {
  return (await backupFolders(db, dataDir)).slice(KEEP_NEWEST_BACKUPS);
}

export async function planBackups({ db, dataDir }: { db: PrismaClient; dataDir: string }): Promise<Plan> {
  const folders = await oldBackups(db, dataDir);
  return total(await Promise.all(folders.map((folder) => diskBytes(folder))));
}

// Keeps the newest 3 backups. A running backup is the newest, so it is never one of them.
export async function removeOldBackups({ db, dataDir }: { db: PrismaClient; dataDir: string }): Promise<Plan> {
  const folders = await oldBackups(db, dataDir);
  const sizes: number[] = [];
  for (const folder of folders) {
    sizes.push(await diskBytes(folder));
    await rm(folder, { recursive: true, force: true });
  }
  await db.backup.deleteMany({ where: { path: { in: folders } } });
  return total(sizes);
}

async function bigLogs(dataDir: string): Promise<Array<{ file: string; size: number }>> {
  const logs: Array<{ file: string; size: number }> = [];
  for (const file of logFiles(dataDir)) {
    if (!(await exists(file))) continue;
    const { size } = await stat(file);
    if (size > LOG_LIMIT_BYTES) logs.push({ file, size });
  }
  return logs;
}

export async function planLogs({ dataDir }: { dataDir: string }): Promise<Plan> {
  return total((await bigLogs(dataDir)).map((log) => log.size - LOG_KEEP_BYTES));
}

// Cuts each log over 10 MB to its last 1 MB, from the first full line. A log the running app holds open, which
// Windows does not let another process write, is named in `inUse` and left as it is.
export async function trimLogs({ dataDir }: { dataDir: string }): Promise<Plan & { inUse: string[] }> {
  const freed: number[] = [];
  const inUse: string[] = [];
  for (const { file, size } of await bigLogs(dataDir)) {
    let handle;
    try {
      handle = await open(file, "r+");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        inUse.push(path.basename(file));
        continue;
      }
      throw err;
    }
    try {
      const tail = Buffer.alloc(LOG_KEEP_BYTES);
      const { bytesRead } = await handle.read(tail, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
      if (bytesRead !== LOG_KEEP_BYTES) throw new Error(`${file}: read ${bytesRead} bytes of its last ${LOG_KEEP_BYTES}`);
      const newline = tail.indexOf(0x0a);
      const kept = newline >= 0 ? tail.subarray(newline + 1) : tail;
      await handle.write(kept, 0, kept.length, 0);
      await handle.truncate(kept.length);
      freed.push(size - kept.length);
    } finally {
      await handle.close();
    }
  }
  return { ...total(freed), inUse };
}

// Entries in <data>\tmp, and Remotion's bundles left in the system temp folder by a stopped render, untouched for an
// hour: a running job's are newer.
async function oldTemp(dataDir: string, tmpDir: string, now: Date): Promise<string[]> {
  const folder = tempFolder(dataDir);
  const candidates = [
    ...((await exists(folder)) ? (await readdir(folder)).map((name) => path.join(folder, name)) : []),
    ...(await remotionBundles(tmpDir)),
  ];
  const old: string[] = [];
  for (const entry of candidates) {
    if (now.getTime() - (await stat(entry)).mtime.getTime() >= TEMP_MIN_AGE_MS) old.push(entry);
  }
  return old;
}

export async function planTemp({ dataDir, tmpDir = os.tmpdir(), now }: { dataDir: string; tmpDir?: string; now: Date }): Promise<Plan> {
  const entries = await oldTemp(dataDir, tmpDir, now);
  return total(await Promise.all(entries.map((entry) => diskBytes(entry))));
}

export async function cleanTemp({ dataDir, tmpDir = os.tmpdir(), now }: { dataDir: string; tmpDir?: string; now: Date }): Promise<Plan> {
  const sizes: number[] = [];
  for (const entry of await oldTemp(dataDir, tmpDir, now)) {
    sizes.push(await diskBytes(entry));
    await rm(entry, { recursive: true, force: true });
  }
  return total(sizes);
}
