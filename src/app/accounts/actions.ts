"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { disconnectAccount, pauseAccount, resumeAccount } from "@/lib/account-management";
import { prisma } from "@/lib/prisma";
import { getPublishQueue, getYouTubePublishQueue } from "@/lib/queues";
import { disconnectYouTubeChannel } from "@/lib/youtube-accounts";

export async function pauseAccountAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await pauseAccount(prisma, {
      ownerId: await getOwnerId(),
      accountId: String(formData.get("accountId") ?? ""),
      minutes: Number(formData.get("minutes") ?? 60),
      now: new Date(),
    });
    revalidatePath("/accounts");
    return "Paused";
  });
}

export async function resumeAccountAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await resumeAccount(prisma, { ownerId: await getOwnerId(), accountId: String(formData.get("accountId") ?? "") });
    revalidatePath("/accounts");
    return "Resumed";
  });
}

export async function disconnectAccountAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await disconnectAccount(prisma, getPublishQueue(), {
      ownerId: await getOwnerId(),
      accountId: String(formData.get("accountId") ?? ""),
    });
    revalidatePath("/");
    revalidatePath("/accounts");
    revalidatePath("/scheduled");
    return "Disconnected";
  });
}

// Localirs forgets the channel's login; the access itself is removed under Third-party apps in the Google Account.
export async function disconnectYouTubeAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await disconnectYouTubeChannel(prisma, getYouTubePublishQueue(), {
      ownerId: await getOwnerId(),
      ytAccountId: String(formData.get("ytAccountId") ?? ""),
    });
    revalidatePath("/accounts");
    revalidatePath("/scheduled");
    return "Disconnected";
  });
}
