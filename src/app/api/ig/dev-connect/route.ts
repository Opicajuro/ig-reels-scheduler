// Simulates the result of connecting an Instagram account, for UI testing without a Meta app.
// Off unless `next dev` runs with IG_MOCK=true in .env; see src/lib/mock-accounts.ts.
import { getOwnerId } from "@/lib/owner";
import { createMockAccount, mockConnectEnabled } from "@/lib/mock-accounts";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";

export async function POST(request: Request) {
  if (!mockConnectEnabled(process.env)) {
    return new Response("dev-connect is only available with IG_MOCK=true under next dev", { status: 404 });
  }
  const ownerId = await getOwnerId();

  const account = await createMockAccount(prisma, { ownerId: ownerId, key: loadTokenKey() });
  // The button on /accounts is a plain form, so a browser goes back to the list; API callers get the account.
  if (request.headers.get("accept")?.includes("text/html")) {
    return Response.redirect(new URL("/accounts", request.url), 303);
  }
  return Response.json(account, { status: 201 });
}
