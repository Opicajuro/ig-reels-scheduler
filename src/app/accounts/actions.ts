"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { disconnectAccount, pauseAccount, resumeAccount } from "@/lib/account-management";
import { prisma } from "@/lib/prisma";
import { getPublishQueue } from "@/lib/queues";

// Every action checks the session, and the functions it calls check the account's owner, since any action can be
// called directly.
async function currentOwnerId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
}

export async function pauseAccountAction(formData: FormData) {
  await pauseAccount(prisma, {
    ownerId: await currentOwnerId(),
    accountId: String(formData.get("accountId") ?? ""),
    minutes: Number(formData.get("minutes") ?? 60),
    now: new Date(),
  });
  revalidatePath("/accounts");
}

export async function resumeAccountAction(formData: FormData) {
  await resumeAccount(prisma, { ownerId: await currentOwnerId(), accountId: String(formData.get("accountId") ?? "") });
  revalidatePath("/accounts");
}

export async function disconnectAccountAction(formData: FormData) {
  await disconnectAccount(prisma, getPublishQueue(), {
    ownerId: await currentOwnerId(),
    accountId: String(formData.get("accountId") ?? ""),
  });
  revalidatePath("/accounts");
  revalidatePath("/dashboard");
}
