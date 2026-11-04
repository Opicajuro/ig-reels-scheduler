import { statfs } from "node:fs/promises";
import { formatBytes } from "./backup";
import { UserError } from "./user-error";

// Free space on the data drive: Home warns below 5 GB, and the big jobs refuse to start below 2 GB.
export const LOW_SPACE_BYTES = 5 * 1024 ** 3;
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

export type FreeSpace = (dir: string) => Promise<number>;

export const driveFreeBytes: FreeSpace = async (dir) => {
  const { bavail, bsize } = await statfs(dir);
  return bavail * bsize;
};

// The check before a big job: clip making, an engine install or a slideshow. Below 2 GB free on the data drive it
// refuses, with a link to the Storage page.
export async function requireFreeSpace(dataDir: string, freeSpace: FreeSpace = driveFreeBytes): Promise<void> {
  const free = await freeSpace(dataDir);
  if (free < MIN_FREE_BYTES) {
    throw new UserError(
      `Only ${formatBytes(free)} is free on the data drive, and this needs at least ${formatBytes(MIN_FREE_BYTES)}. Free up space first.`,
      { href: "/storage", label: "Open Storage" },
    );
  }
}
