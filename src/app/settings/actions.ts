"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/prisma";
import { saveSettings } from "@/lib/settings";

export async function saveSettingsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const text = (name: string) => String(formData.get(name) ?? "");
    await saveSettings(prisma, {
      metaAppId: text("metaAppId"),
      metaAppSecret: text("metaAppSecret"),
      alertEmail: text("alertEmail"),
      resendApiKey: text("resendApiKey"),
      emailFrom: text("emailFrom"),
      captionLanguage: text("captionLanguage"),
    });
    // Home, Accounts and Privacy show what these settings decide.
    revalidatePath("/", "layout");
    return "Settings saved";
  });
}
