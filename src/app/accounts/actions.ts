"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { getOwnerId } from "@/lib/owner";
import { disconnectAccount, pauseAccount, resumeAccount } from "@/lib/account-management";
import { prisma } from "@/lib/prisma";
import { getPublishQueue } from "@/lib/queues";

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
    revalidatePath("/accounts");
    revalidatePath("/dashboard");
    return "Disconnected";
  });
}
