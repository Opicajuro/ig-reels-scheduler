"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { prisma } from "@/lib/prisma";
import { getSlideshowEngineQueue } from "@/lib/queues";
import {
  isSlideshowEngineId,
  SLIDESHOW_ENGINES,
  slideshowDir,
  startSlideshowEngineInstall,
  uninstallSlideshowEngine,
  type SlideshowEngineId,
} from "@/lib/slideshow-engines";
import { UserError } from "@/lib/user-error";

function engineOf(formData: FormData): SlideshowEngineId {
  const engine = String(formData.get("engine") ?? "");
  if (!isSlideshowEngineId(engine)) throw new UserError("unknown slideshow engine");
  return engine;
}

// The Clips page's slideshow tab changes with the engines, so both pages are refreshed.
export async function installSlideshowEngineAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const engine = engineOf(formData);
    await startSlideshowEngineInstall({ db: prisma, queue: getSlideshowEngineQueue(), engine });
    revalidatePath("/settings");
    revalidatePath("/clips");
    return `Installing the ${SLIDESHOW_ENGINES[engine].name.toLowerCase()}`;
  });
}

export async function uninstallSlideshowEngineAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const engine = engineOf(formData);
    await uninstallSlideshowEngine({ db: prisma, root: slideshowDir(), engine });
    revalidatePath("/settings");
    revalidatePath("/clips");
    return `${SLIDESHOW_ENGINES[engine].name} removed`;
  });
}
