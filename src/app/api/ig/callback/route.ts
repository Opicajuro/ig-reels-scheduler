import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOwnerId } from "@/lib/owner";
import { saveConnectedAccount } from "@/lib/accounts";
import { connectAccount, metaAppConfig } from "@/lib/ig-connect";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();

  const url = new URL(request.url);
  const store = await cookies();
  const expectedState = store.get("ig_oauth_state")?.value ?? "";
  store.delete("ig_oauth_state");

  const app = metaAppConfig(await getSettings(prisma), process.env.IG_REDIRECT_URI);
  if (!app) return new Response("No Meta app is set up. Add its app ID and secret on the Settings page.", { status: 400 });

  try {
    const account = await connectAccount({
      ...app,
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state") ?? "",
      expectedState,
    });
    await saveConnectedAccount(ownerId, account);
  } catch (err) {
    const message = err instanceof Error ? err.message : "connection failed";
    return new Response(message, { status: 400 });
  }

  redirect("/accounts");
}
