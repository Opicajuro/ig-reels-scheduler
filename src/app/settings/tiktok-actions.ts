"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/prisma";
import { saveTikTokSettings } from "@/lib/settings";

export async function saveTikTokSettingsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const text = (name: string) => String(formData.get(name) ?? "");
    await saveTikTokSettings(prisma, { tiktokClientKey: text("tiktokClientKey"), tiktokClientSecret: text("tiktokClientSecret") });
    revalidatePath("/accounts");
    revalidatePath("/settings");
    return "TikTok saved";
  });
}
