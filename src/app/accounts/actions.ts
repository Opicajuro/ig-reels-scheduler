"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { disconnectAccount, pauseAccount, resumeAccount } from "@/lib/account-management";
import { prisma } from "@/lib/prisma";
import { getFacebookPublishQueue, getPublishQueue, getTikTokPublishQueue, getYouTubePublishQueue } from "@/lib/queues";
import { disconnectFacebookPage } from "@/lib/facebook-accounts";
import { disconnectTikTokAccount } from "@/lib/tiktok-accounts";
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

// Localirs forgets the Page token; the access itself is removed under Business Integrations in Facebook's settings.
export async function disconnectFacebookAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await disconnectFacebookPage(prisma, getFacebookPublishQueue(), {
      ownerId: await getOwnerId(),
      fbPageId: String(formData.get("fbPageId") ?? ""),
    });
    revalidatePath("/accounts");
    revalidatePath("/scheduled");
    return "Disconnected";
  });
}

// Localirs forgets the login; the access itself is removed under Manage app permissions in the TikTok app.
export async function disconnectTikTokAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await disconnectTikTokAccount(prisma, getTikTokPublishQueue(), {
      ownerId: await getOwnerId(),
      ttAccountId: String(formData.get("ttAccountId") ?? ""),
    });
    revalidatePath("/accounts");
    revalidatePath("/scheduled");
    return "Disconnected";
  });
}
