import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOwnerId } from "@/lib/owner";
import { saveConnectedAccount } from "@/lib/accounts";
import { requireEnv } from "@/lib/env";
import { connectAccount } from "@/lib/ig-connect";

export async function GET(request: Request) {
  const ownerId = await getOwnerId();

  const url = new URL(request.url);
  const store = await cookies();
  const expectedState = store.get("ig_oauth_state")?.value ?? "";
  store.delete("ig_oauth_state");

  try {
    const account = await connectAccount({
      appId: requireEnv("IG_APP_ID"),
      appSecret: requireEnv("IG_APP_SECRET"),
      redirectUri: requireEnv("IG_REDIRECT_URI"),
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
