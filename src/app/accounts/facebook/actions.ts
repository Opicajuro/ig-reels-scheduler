"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "@/lib/action-result";
import { FACEBOOK_PICK_COOKIE, listManagedPages } from "@/lib/facebook";
import { saveFacebookPages } from "@/lib/facebook-accounts";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { openSecret } from "@/lib/settings";
import { loadTokenKey } from "@/lib/token-crypto";
import { UserError } from "@/lib/user-error";

// Saves the picked Pages with tokens read again from Facebook, so the browser never holds a Page token.
export async function connectFacebookPagesAction(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const store = await cookies();
    const sealed = store.get(FACEBOOK_PICK_COOKIE)?.value;
    if (!sealed) throw new UserError("the Facebook login expired; connect again from the Accounts page");
    const key = loadTokenKey();
    const pages = await listManagedPages({ userToken: openSecret(sealed, key) });
    await saveFacebookPages(prisma, key, { ownerId: await getOwnerId(), pages, pageIds: formData.getAll("pageId").map(String) });
    store.delete(FACEBOOK_PICK_COOKIE);
    revalidatePath("/accounts");
    redirect("/accounts");
  });
}
