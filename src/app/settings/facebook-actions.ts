"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/prisma";
import { saveFacebookSettings } from "@/lib/settings";

export async function saveFacebookSettingsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await saveFacebookSettings(prisma, { fbLoginConfigId: String(formData.get("fbLoginConfigId") ?? "") });
    revalidatePath("/accounts");
    revalidatePath("/settings");
    return "Facebook saved";
  });
}
