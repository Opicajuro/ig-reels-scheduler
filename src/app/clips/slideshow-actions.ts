"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getSlideshowQueue } from "@/lib/queues";
import { createSlideshowScript, startSlideshowRender } from "@/lib/slideshow";
import { UserError } from "@/lib/user-error";

export async function writeScriptAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await createSlideshowScript({
      db: prisma,
      queue: getSlideshowQueue(),
      ownerId: await getOwnerId(),
      topic: String(formData.get("topic") ?? ""),
      slideCount: Number(formData.get("slideCount")),
    });
    revalidatePath("/clips");
    return "Writing the script";
  });
}

// The editor sends its slides as JSON in the "slides" field.
export async function makeSlideshowAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    let slides: unknown;
    try {
      slides = JSON.parse(String(formData.get("slides") ?? ""));
    } catch {
      throw new UserError("the slides could not be read; reload the page and try again");
    }
    await startSlideshowRender({
      db: prisma,
      queue: getSlideshowQueue(),
      ownerId: await getOwnerId(),
      jobId: String(formData.get("jobId") ?? ""),
      slides,
      voice: String(formData.get("voice") ?? ""),
      captionPreset: String(formData.get("captionPreset") ?? ""),
    });
    revalidatePath("/clips");
    return "Making the slideshow";
  });
}
