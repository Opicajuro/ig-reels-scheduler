"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/prisma";
import { testR2Connection } from "@/lib/r2";
import { getSettings, r2Settings, saveR2Settings } from "@/lib/settings";
import { UserError } from "@/lib/user-error";

export async function saveR2SettingsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const text = (name: string) => String(formData.get(name) ?? "");
    await saveR2Settings(prisma, {
      r2AccountId: text("r2AccountId"),
      r2AccessKeyId: text("r2AccessKeyId"),
      r2SecretAccessKey: text("r2SecretAccessKey"),
      r2Bucket: text("r2Bucket"),
    });
    // Home lists Instagram posting as needing attention until R2 is saved.
    revalidatePath("/", "layout");
    return "Cloudflare R2 saved";
  });
}

// Tests the saved values, the ones publishing uses.
export async function testR2Action(): Promise<ActionResult> {
  return runAction(async () => {
    const config = r2Settings(await getSettings(prisma));
    if (!config) throw new UserError("save all four R2 values first, then test them");
    await testR2Connection(config);
    return "R2 works: a test file was uploaded, downloaded through a link and deleted";
  });
}
