import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backupName,
  backupsToDelete,
  buildManifest,
  KEEP_BACKUPS,
  pendingRestore,
  requestRestore,
  RESTORE_REQUEST_FILE,
  validateBackupFolder,
} from "./backup";
import { UserError } from "./user-error";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "backup-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("backupName", () => {
  it("names a backup by its local date and time, so the names sort in time order", () => {
    expect(backupName(new Date(2026, 9, 3, 3, 30, 5))).toBe("localirs-2026-10-03_033005");
  });
});

describe("backupsToDelete", () => {
  it(`keeps the newest ${KEEP_BACKUPS} backups and deletes the older ones`, () => {
    const names = Array.from({ length: 20 }, (_, day) => backupName(new Date(2026, 9, day + 1, 3, 30)));
    const deleted = backupsToDelete([...names].reverse());
    expect(deleted).toEqual(names.slice(0, 6).reverse());
  });

  it("never touches other files and folders in the backup folder", () => {
    const names = Array.from({ length: 15 }, (_, day) => backupName(new Date(2026, 9, day + 1, 3, 30)));
    const deleted = backupsToDelete([...names, "holiday photos", "localirs-notes.txt", "localirs-2026-10-01"]);
    expect(deleted).toEqual([names[0]]);
  });

  it("deletes nothing while there are 14 or fewer", () => {
    expect(backupsToDelete([backupName(new Date(2026, 0, 1))])).toEqual([]);
  });
});

describe("validateBackupFolder", () => {
  const dataDir = () => path.join(root, "data");

  it("creates a missing folder it can write to", async () => {
    const folder = path.join(root, "other drive", "Localirs backups");
    await validateBackupFolder(folder, dataDir());
    expect((await stat(folder)).isDirectory()).toBe(true);
  });

  it("rejects a relative path", async () => {
    await expect(validateBackupFolder("backups", dataDir())).rejects.toThrow(UserError);
  });

  it("rejects a folder inside the file storage or the database", async () => {
    await expect(validateBackupFolder(path.join(dataDir(), "seaweedfs", "b"), dataDir())).rejects.toThrow(/seaweedfs/);
    await expect(validateBackupFolder(path.join(dataDir(), "postgres"), dataDir())).rejects.toThrow(/postgres/);
  });

  it("rejects a folder it cannot write to", async () => {
    const file = path.join(root, "a-file");
    await writeFile(file, "");
    await expect(validateBackupFolder(path.join(file, "backups"), dataDir())).rejects.toThrow(/cannot write to/);
  });
});

describe("buildManifest", () => {
  it("records the time, the app build, the database size and whether clips are included", () => {
    expect(
      buildManifest({ now: new Date("2026-10-30T02:30:00Z"), appBuild: "57", databaseBytes: BigInt(8_000_000), includeClips: true }),
    ).toEqual({ createdAt: "2026-10-30T02:30:00.000Z", appBuild: "57", databaseBytes: 8_000_000, includeClips: true });
  });
});

describe("requestRestore", () => {
  it("writes the request the start script reads, and pendingRestore reads it back", async () => {
    const dataDir = path.join(root, "restore-data");
    const backup = path.join(root, "backups", "localirs-2026-10-30_033000");
    await mkdir(dataDir, { recursive: true });
    await mkdir(backup, { recursive: true });
    await writeFile(path.join(backup, "localirs.dump"), "dump");
    await writeFile(path.join(backup, "manifest.json"), "{}");
    expect(await pendingRestore(dataDir)).toBeNull();

    await requestRestore(dataDir, backup, new Date("2026-10-30T10:00:00Z"));

    const request = JSON.parse(await readFile(path.join(dataDir, RESTORE_REQUEST_FILE), "utf8"));
    expect(request).toEqual({ backupPath: backup, requestedAt: "2026-10-30T10:00:00.000Z" });
    expect(await pendingRestore(dataDir)).toEqual(request);
  });

  it("refuses a backup folder without its dump", async () => {
    const dataDir = path.join(root, "restore-data-2");
    const backup = path.join(root, "backups", "localirs-2026-10-29_033000");
    await mkdir(dataDir, { recursive: true });
    await mkdir(backup, { recursive: true });
    await expect(requestRestore(dataDir, backup, new Date())).rejects.toThrow(/no localirs.dump/);
    expect(await pendingRestore(dataDir)).toBeNull();
  });
});
