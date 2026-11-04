import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@/generated/prisma/client";
import { backupsToDelete, getBackupSettings } from "./backup";
import { driveFreeBytes, type FreeSpace } from "./free-space";
import { REPORT_LOG_FILES } from "./problem-report";
import { SLIDESHOW_ENGINE_IDS, type SlideshowEngineId } from "./slideshow-engines";
import type { StoredObject } from "./storage";

// The Storage page's numbers: free space on the data drive, the stored objects by what they are, and the data folder's
// engines, backups, logs and temp files.
const CACHE_MS = 60_000;

export const STORED_CATEGORIES = {
  sources: "Videos (sources)",
  clips: "Clips",
  captionCopies: "Caption-edit copies",
  posts: "Post copies",
  pictures: "Uploaded pictures",
  other: "Other stored files",
} as const;
export type StoredCategory = keyof typeof STORED_CATEGORIES;

export function storedCategory(key: string): StoredCategory {
  if (key.startsWith("clip-sources/")) return "sources";
  if (key.startsWith("clips/")) return key.endsWith(".base.mp4") ? "captionCopies" : "clips";
  if (key.startsWith("raw/") || key.startsWith("reels/") || key.startsWith("youtube/")) return "posts";
  if (key.startsWith("ai-inputs/") || key.startsWith("slideshow-inputs/")) return "pictures";
  return "other";
}

// The logs the installed app writes to its data folder (installer/services.ps1, the setup, start and stop scripts and
// the restore), and those the AI video engine and the script writer write next to themselves.
export function logFiles(dataDir: string): string[] {
  return [
    ...[...REPORT_LOG_FILES, "restore.log"].map((name) => path.join(dataDir, name)),
    path.join(dataDir, "ai", "comfyui.log"),
    path.join(dataDir, "slideshow", "llama-server.log"),
  ];
}

export function tempFolder(dataDir: string): string {
  return path.join(dataDir, "tmp");
}

export const REMOTION_BUNDLE_PREFIX = "remotion-webpack-bundle-";

export async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

// A file's size, or a folder's with everything in it; 0 for one that is not there. Files in `skip` are not counted.
export async function diskBytes(target: string, skip: ReadonlySet<string> = new Set()): Promise<number> {
  if (skip.has(target)) return 0;
  const info = await stat(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(target)) total += await diskBytes(path.join(target, name), skip);
  return total;
}

export type StorageSnapshot = {
  measuredAt: Date;
  freeBytes: number;
  objects: StoredObject[];
  stored: Record<StoredCategory, number>;
  aiEngineBytes: number;
  slideshowEngineBytes: Record<SlideshowEngineId, number>;
  backupBytes: number;
  logBytes: number;
  tempBytes: number;
};

export type MeasureInput = {
  db: PrismaClient;
  dataDir: string;
  list: () => AsyncIterable<StoredObject>;
  tmpDir?: string;
  freeSpace?: FreeSpace;
  now: Date;
};

// Measures everything once. The engine folders are counted without their logs, which are counted as logs.
export async function measureStorage({ db, dataDir, list, tmpDir = os.tmpdir(), freeSpace = driveFreeBytes, now }: MeasureInput): Promise<StorageSnapshot> {
  const objects: StoredObject[] = [];
  for await (const item of list()) objects.push(item);
  const stored = Object.fromEntries(Object.keys(STORED_CATEGORIES).map((category) => [category, 0])) as Record<StoredCategory, number>;
  for (const item of objects) stored[storedCategory(item.key)] += item.size;

  const logs = logFiles(dataDir);
  const skip = new Set(logs);
  const slideshowEngineBytes = {} as Record<SlideshowEngineId, number>;
  for (const engine of SLIDESHOW_ENGINE_IDS) {
    slideshowEngineBytes[engine] = await diskBytes(path.join(dataDir, "slideshow", engine), skip);
  }
  const backups = await backupFolders(db, dataDir);
  let backupBytes = 0;
  for (const folder of backups) backupBytes += await diskBytes(folder);
  let logBytes = 0;
  for (const file of logs) logBytes += await diskBytes(file);
  let tempBytes = await diskBytes(tempFolder(dataDir));
  for (const bundle of await remotionBundles(tmpDir)) tempBytes += await diskBytes(bundle);

  return {
    measuredAt: now,
    freeBytes: await freeSpace(dataDir),
    objects,
    stored,
    aiEngineBytes: await diskBytes(path.join(dataDir, "ai"), skip),
    slideshowEngineBytes,
    backupBytes,
    logBytes,
    tempBytes,
  };
}

// The backup folders in the backup folder, newest first. Before the first backup there is no folder yet.
export async function backupFolders(db: PrismaClient, dataDir: string): Promise<string[]> {
  const { folder } = await getBackupSettings(db, dataDir);
  if (!(await exists(folder))) return [];
  return backupsToDelete(await readdir(folder), 0).map((name) => path.join(folder, name));
}

export async function remotionBundles(tmpDir: string): Promise<string[]> {
  return (await readdir(tmpDir)).filter((name) => name.startsWith(REMOTION_BUNDLE_PREFIX)).map((name) => path.join(tmpDir, name));
}

let cached: StorageSnapshot | null = null;

// The page's snapshot, measured again after a minute, on "Refresh" and after every clean-up.
export async function cachedStorage(input: MeasureInput & { refresh?: boolean }): Promise<StorageSnapshot> {
  if (!input.refresh && cached && input.now.getTime() - cached.measuredAt.getTime() < CACHE_MS) return cached;
  cached = await measureStorage(input);
  return cached;
}

export function forgetStorage(): void {
  cached = null;
}

export type ProjectUsage = {
  id: string;
  name: string;
  status: string;
  hasSource: boolean;
  sourceDeletedAt: Date | null;
  sourceBytes: number;
  clipsBytes: number;
};

// Each of the owner's projects with the size of its stored video and of its clips' files (old versions and
// caption-edit copies included), largest first.
export async function projectUsage(db: PrismaClient, ownerId: string, objects: StoredObject[]): Promise<ProjectUsage[]> {
  const sizes = new Map(objects.map((item) => [item.key, item.size]));
  const clipBytes = new Map<string, number>();
  for (const item of objects) {
    const match = /^clips\/([^/]+)\//.exec(item.key);
    if (match) clipBytes.set(match[1], (clipBytes.get(match[1]) ?? 0) + item.size);
  }
  const projects = await db.clipProject.findMany({
    where: { ownerId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, status: true, sourceKey: true, sourceDeletedAt: true, aiVideos: true, slideshows: true },
  });
  return projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      hasSource: !project.aiVideos && !project.slideshows,
      sourceDeletedAt: project.sourceDeletedAt,
      sourceBytes: project.sourceKey ? (sizes.get(project.sourceKey) ?? 0) : 0,
      clipsBytes: clipBytes.get(project.id) ?? 0,
    }))
    .sort((a, b) => b.sourceBytes + b.clipsBytes - (a.sourceBytes + a.clipsBytes));
}
