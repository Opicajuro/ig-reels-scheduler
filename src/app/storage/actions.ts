"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { formatBytes } from "@/lib/backup";
import { deleteProject, deleteProjectSource } from "@/lib/clip-projects";
import { s3ClipStore } from "@/lib/clip-store";
import { requireEnv } from "@/lib/env";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { listObjects, type StoredObject } from "@/lib/storage";
import {
  cleanTemp,
  parseBaseCutDays,
  removeBaseCuts,
  removeOldBackups,
  removeOrphans,
  trimLogs,
  type Plan,
} from "@/lib/storage-cleanup";
import { forgetStorage } from "@/lib/storage-usage";

async function allObjects(): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  for await (const item of listObjects()) objects.push(item);
  return objects;
}

function freed({ count, bytes }: Plan, what: string): string {
  return count === 0 ? `No ${what} to remove` : `Freed ${formatBytes(bytes)}`;
}

// Every change here also changes the Clips pages' projects and clips.
function measureAgain(): void {
  forgetStorage();
  revalidatePath("/storage");
  revalidatePath("/clips", "layout");
}

export async function refreshStorageAction(): Promise<ActionResult> {
  return runAction(async () => {
    measureAgain();
    return "Measured again";
  });
}

export async function deleteSourceAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await deleteProjectSource({
      db: prisma,
      store: s3ClipStore,
      ownerId: await getOwnerId(),
      projectId: String(formData.get("projectId") ?? ""),
      now: new Date(),
    });
    measureAgain();
    return "Source video deleted; the clips are kept";
  });
}

export async function deleteStoredProjectAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await deleteProject({ db: prisma, store: s3ClipStore, ownerId: await getOwnerId(), projectId: String(formData.get("projectId") ?? "") });
    measureAgain();
    return "Project deleted";
  });
}

export async function removeOrphansAction(): Promise<ActionResult> {
  return runAction(async () => {
    const result = await removeOrphans({ db: prisma, store: s3ClipStore, objects: await allObjects(), now: new Date() });
    measureAgain();
    return freed(result, "orphaned files");
  });
}

export async function removeBaseCutsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const days = parseBaseCutDays(formData.get("days"));
    const result = await removeBaseCuts({ db: prisma, store: s3ClipStore, objects: await allObjects(), days, now: new Date() });
    measureAgain();
    return freed(result, "caption-edit copies");
  });
}

export async function removeOldBackupsAction(): Promise<ActionResult> {
  return runAction(async () => {
    const result = await removeOldBackups({ db: prisma, dataDir: requireEnv("LOCALIRS_DATA_DIR") });
    measureAgain();
    revalidatePath("/settings");
    return freed(result, "old backups");
  });
}

export async function trimLogsAction(): Promise<ActionResult> {
  return runAction(async () => {
    const result = await trimLogs({ dataDir: requireEnv("LOCALIRS_DATA_DIR") });
    measureAgain();
    const busy = result.inUse.length > 0 ? `. In use, so left as they are: ${result.inUse.join(", ")}` : "";
    return `${freed(result, "big logs")}${busy}`;
  });
}

export async function cleanTempAction(): Promise<ActionResult> {
  return runAction(async () => {
    const result = await cleanTemp({ dataDir: requireEnv("LOCALIRS_DATA_DIR"), now: new Date() });
    measureAgain();
    return freed(result, "temporary files");
  });
}
