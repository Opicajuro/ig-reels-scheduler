"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { requestRestore, saveBackupSettings } from "@/lib/backup";
import { requireEnv } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { enqueueBackup } from "@/lib/queues";
import { UserError } from "@/lib/user-error";

export async function saveBackupSettingsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await saveBackupSettings(prisma, requireEnv("LOCALIRS_DATA_DIR"), {
      folder: String(formData.get("folder") ?? ""),
      includeClips: formData.get("includeClips") === "on",
    });
    revalidatePath("/settings");
    return "Backup settings saved";
  });
}

// The worker makes the backup; the list shows it as running until it is done.
export async function backUpNowAction(): Promise<ActionResult> {
  return runAction(async () => {
    await enqueueBackup();
    revalidatePath("/settings");
    return "Backup started";
  });
}

export async function restoreBackupAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const backup = await prisma.backup.findUnique({ where: { id: String(formData.get("backupId")) } });
    if (!backup || backup.status !== "ok") throw new UserError("this backup did not finish, so it cannot be restored");
    await requestRestore(requireEnv("LOCALIRS_DATA_DIR"), backup.path, new Date());
    revalidatePath("/settings");
    return "Restore ready: quit Localirs from its tray icon and open it again";
  });
}
