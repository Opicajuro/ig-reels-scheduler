"use server";

import { revalidatePath } from "next/cache";
import { runAction, type ActionResult } from "@/lib/action-result";
import { addGuideLink, addProfileLink, removeGuideLink, removeProfileLink } from "@/lib/links";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { saveSettings } from "@/lib/settings";

export async function saveSettingsAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const text = (name: string) => String(formData.get(name) ?? "");
    await saveSettings(prisma, {
      metaAppId: text("metaAppId"),
      metaAppSecret: text("metaAppSecret"),
      alertEmail: text("alertEmail"),
      resendApiKey: text("resendApiKey"),
      emailFrom: text("emailFrom"),
    });
    // Home, Accounts and Privacy show what these settings decide.
    revalidatePath("/", "layout");
    return "Settings saved";
  });
}

// Home and Privacy show the profiles; Help lists the guides.
export async function addProfileLinkAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await addProfileLink({ db: prisma, ownerId: await getOwnerId(), url: String(formData.get("url") ?? "") });
    revalidatePath("/", "layout");
    return "Profile added";
  });
}

export async function removeProfileLinkAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await removeProfileLink({ db: prisma, ownerId: await getOwnerId(), linkId: String(formData.get("linkId") ?? "") });
    revalidatePath("/", "layout");
    return "Profile removed";
  });
}

export async function addGuideLinkAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await addGuideLink({
      db: prisma,
      ownerId: await getOwnerId(),
      title: String(formData.get("title") ?? ""),
      url: String(formData.get("url") ?? ""),
    });
    revalidatePath("/", "layout");
    return "Guide added";
  });
}

export async function removeGuideLinkAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    await removeGuideLink({ db: prisma, ownerId: await getOwnerId(), linkId: String(formData.get("linkId") ?? "") });
    revalidatePath("/", "layout");
    return "Guide removed";
  });
}
