// Simulates the result of connecting an Instagram account, for UI testing without a Meta app.
// Off unless `next dev` runs with IG_MOCK=true in .env; see src/lib/mock-accounts.ts.
import { auth } from "@/auth";
import { createMockAccount, mockConnectEnabled } from "@/lib/mock-accounts";
import { prisma } from "@/lib/prisma";
import { loadTokenKey } from "@/lib/token-crypto";

export async function POST(request: Request) {
  if (!mockConnectEnabled(process.env)) {
    return new Response("dev-connect is only available with IG_MOCK=true under next dev", { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) return new Response("sign in required", { status: 401 });

  const account = await createMockAccount(prisma, { ownerId: session.user.id, key: loadTokenKey() });
  // The button on /accounts is a plain form, so a browser goes back to the list; API callers get the account.
  if (request.headers.get("accept")?.includes("text/html")) {
    return Response.redirect(new URL("/accounts", request.url), 303);
  }
  return Response.json(account, { status: 201 });
}
