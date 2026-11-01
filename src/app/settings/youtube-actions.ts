"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/prisma";
import { saveYouTubeSettings } from "@/lib/settings";

export async function saveYouTubeSettingsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const text = (name: string) => String(formData.get(name) ?? "");
    await saveYouTubeSettings(prisma, {
      googleClientId: text("googleClientId"),
      googleClientSecret: text("googleClientSecret"),
    });
    revalidatePath("/accounts");
    revalidatePath("/settings");
    return "YouTube saved";
  });
}
