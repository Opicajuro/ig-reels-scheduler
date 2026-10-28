"use server";

import { revalidatePath } from "next/cache";
import { getOwnerId } from "@/lib/owner";
import { disconnectAccount, pauseAccount, resumeAccount } from "@/lib/account-management";
import { prisma } from "@/lib/prisma";
import { getPublishQueue } from "@/lib/queues";

export async function pauseAccountAction(formData: FormData) {
  await pauseAccount(prisma, {
    ownerId: await getOwnerId(),
    accountId: String(formData.get("accountId") ?? ""),
    minutes: Number(formData.get("minutes") ?? 60),
    now: new Date(),
  });
  revalidatePath("/accounts");
}

export async function resumeAccountAction(formData: FormData) {
  await resumeAccount(prisma, { ownerId: await getOwnerId(), accountId: String(formData.get("accountId") ?? "") });
  revalidatePath("/accounts");
}

export async function disconnectAccountAction(formData: FormData) {
  await disconnectAccount(prisma, getPublishQueue(), {
    ownerId: await getOwnerId(),
    accountId: String(formData.get("accountId") ?? ""),
  });
  revalidatePath("/accounts");
  revalidatePath("/dashboard");
}
