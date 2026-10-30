import { execFile } from "node:child_process";
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@/generated/prisma/client";
import { UserError } from "./user-error";

// A backup is one folder in the backup folder, named by the local time it was made: the database as a pg_dump custom
// archive, the install's secrets.json, the app's .env (app.env), a manifest, and with "Also back up clips and videos" a copy of the file
// storage. installer/start-localirs.ps1 restores one when data\restore-request.json asks for it.
export const KEEP_BACKUPS = 14;
export const DUMP_FILE = "localirs.dump";
export const MANIFEST_FILE = "manifest.json";
export const RESTORE_REQUEST_FILE = "restore-request.json";
const BACKUP_NAME = /^localirs-\d{4}-\d{2}-\d{2}_\d{6}$/;
const SETTINGS_ID = 1;

const run = promisify(execFile);

export type BackupEnv = {
  /** the install's data folder (LOCALIRS_DATA_DIR) */
  dataDir: string;
  /** the folder with pg_dump (PG_BIN): the PostgreSQL that ships with the install */
  pgBin: string;
  databaseUrl: string;
  /** the app's .env: it holds the key that decrypts the tokens and secrets saved in the database */
  appEnvFile: string;
};

export type Manifest = {
  createdAt: string;
  appBuild: string | null;
  databaseBytes: number;
  includeClips: boolean;
};

export type RestoreRequest = { backupPath: string; requestedAt: string };

export function defaultBackupFolder(dataDir: string): string {
  return path.join(dataDir, "backups");
}

export async function getBackupSettings(db: PrismaClient, dataDir: string): Promise<{ folder: string; includeClips: boolean }> {
  const row = await db.backupSettings.findUnique({ where: { id: SETTINGS_ID } });
  return { folder: row?.folder ?? defaultBackupFolder(dataDir), includeClips: row?.includeClips ?? false };
}

// The folder must be a full path this PC can write to, and not inside the file storage or the database, which a
// backup copies or which Postgres owns. It is created when missing.
export async function validateBackupFolder(folder: string, dataDir: string): Promise<void> {
  if (!path.isAbsolute(folder)) throw new UserError("the backup folder must be a full path, such as D:\\Localirs backups");
  for (const owned of ["seaweedfs", "postgres"]) {
    const relative = path.relative(path.join(dataDir, owned), folder);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      throw new UserError(`the backup folder cannot be inside the data folder's ${owned} folder`);
    }
  }
  const probe = path.join(folder, ".localirs-write-test");
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(probe, "");
    await rm(probe);
  } catch (err) {
    throw new UserError(`Localirs cannot write to ${folder}: ${(err as Error).message}`);
  }
}

export async function saveBackupSettings(
  db: PrismaClient,
  dataDir: string,
  input: { folder: string; includeClips: boolean },
): Promise<void> {
  const folder = input.folder.trim() === "" ? defaultBackupFolder(dataDir) : path.normalize(input.folder.trim());
  await validateBackupFolder(folder, dataDir);
  const data = { folder: folder === defaultBackupFolder(dataDir) ? null : folder, includeClips: input.includeClips };
  await db.backupSettings.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
}

// Local time, so the folders read naturally in Explorer; the name sorts in time order.
export function backupName(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `localirs-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  );
}

// The backup folders beyond the newest `keep`. Anything else in the folder, which the person may have chosen, is
// never touched.
export function backupsToDelete(names: string[], keep = KEEP_BACKUPS): string[] {
  return names
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse()
    .slice(keep);
}

export function buildManifest(input: { now: Date; appBuild: string | null; databaseBytes: bigint; includeClips: boolean }): Manifest {
  return {
    createdAt: input.now.toISOString(),
    appBuild: input.appBuild,
    databaseBytes: Number(input.databaseBytes),
    includeClips: input.includeClips,
  };
}

// The installer writes the build number to <install>\version.txt; a dev copy has none.
async function readAppBuild(dataDir: string): Promise<string | null> {
  const file = path.join(dataDir, "..", "version.txt");
  try {
    await access(file);
  } catch {
    return null;
  }
  return (await readFile(file, "utf8")).trim();
}

export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await folderBytes(full) : (await stat(full)).size;
  }
  return total;
}

// Makes one backup, records it in the Backup table, then deletes the backups beyond the newest 14. A failed backup
// is recorded with its error, its half-written folder is deleted, and the error is thrown on.
export async function runBackup({ db, env, now }: { db: PrismaClient; env: BackupEnv; now: Date }): Promise<void> {
  const settings = await getBackupSettings(db, env.dataDir);
  const target = path.join(settings.folder, backupName(now));
  const backup = await db.backup.create({
    data: { startedAt: now, path: target, includeClips: settings.includeClips },
  });
  try {
    await validateBackupFolder(settings.folder, env.dataDir);
    await mkdir(target);
    await run(path.join(env.pgBin, "pg_dump"), ["--format=custom", `--file=${path.join(target, DUMP_FILE)}`, `--dbname=${env.databaseUrl}`]);
    await cp(path.join(env.dataDir, "secrets.json"), path.join(target, "secrets.json"));
    await cp(env.appEnvFile, path.join(target, "app.env"));
    if (settings.includeClips) await cp(path.join(env.dataDir, "seaweedfs"), path.join(target, "seaweedfs"), { recursive: true });
    const [{ bytes }] = await db.$queryRaw<{ bytes: bigint }[]>`SELECT pg_database_size(current_database()) AS bytes`;
    const manifest = buildManifest({
      now,
      appBuild: await readAppBuild(env.dataDir),
      databaseBytes: bytes,
      includeClips: settings.includeClips,
    });
    await writeFile(path.join(target, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    await db.backup.update({
      where: { id: backup.id },
      data: { status: "ok", finishedAt: new Date(), sizeBytes: await folderBytes(target) },
    });
  } catch (err) {
    await rm(target, { recursive: true, force: true });
    await db.backup.update({
      where: { id: backup.id },
      data: { status: "failed", finishedAt: new Date(), error: (err as Error).message },
    });
    throw err;
  }
  const old = backupsToDelete(await readdir(settings.folder));
  for (const name of old) await rm(path.join(settings.folder, name), { recursive: true, force: true });
  await db.backup.deleteMany({ where: { path: { in: old.map((name) => path.join(settings.folder, name)) } } });
}

// No backup runs while the worker starts, so a row still "running" is either a backup the worker was stopped in the
// middle of, or, after a restore, the restored backup's own row (its dump was taken while it ran). A folder with its
// manifest is a finished backup.
export async function settleUnfinishedBackups(db: PrismaClient, now: Date): Promise<void> {
  for (const backup of await db.backup.findMany({ where: { status: "running" } })) {
    const finished = await access(path.join(backup.path, MANIFEST_FILE)).then(() => true, () => false);
    await db.backup.update({
      where: { id: backup.id },
      data: finished
        ? { status: "ok", finishedAt: now, sizeBytes: await folderBytes(backup.path) }
        : { status: "failed", finishedAt: now, error: "Localirs stopped before the backup finished" },
    });
  }
}

// Restoring replaces the database, so it is not done while the app runs: this file asks the start script to do it
// the next time Localirs starts, before the worker and the web app.
export async function requestRestore(dataDir: string, backupPath: string, now: Date): Promise<void> {
  for (const file of [DUMP_FILE, MANIFEST_FILE]) {
    try {
      await access(path.join(backupPath, file));
    } catch {
      throw new UserError(`${backupPath} is not a complete backup: it has no ${file}`);
    }
  }
  const request: RestoreRequest = { backupPath, requestedAt: now.toISOString() };
  await writeFile(path.join(dataDir, RESTORE_REQUEST_FILE), JSON.stringify(request, null, 2));
}

export async function pendingRestore(dataDir: string): Promise<RestoreRequest | null> {
  const file = path.join(dataDir, RESTORE_REQUEST_FILE);
  try {
    await access(file);
  } catch {
    return null;
  }
  return JSON.parse(await readFile(file, "utf8")) as RestoreRequest;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
