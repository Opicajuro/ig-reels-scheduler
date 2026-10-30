"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { saveAppearance } from "@/lib/appearance";
import { prisma } from "@/lib/prisma";

export async function saveAppearanceAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const text = (name: string) => String(formData.get(name) ?? "");
    await saveAppearance(prisma, { design: text("design"), palette: text("palette"), hue: text("hue") });
    // The root layout puts the design on every page.
    revalidatePath("/", "layout");
    return "Design saved";
  });
}
