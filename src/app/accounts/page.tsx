import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { mockConnectEnabled } from "@/lib/mock-accounts";
import { prisma } from "@/lib/prisma";

async function AccountList() {
  await connection();
  const session = await auth();
  if (!session?.user) redirect("/login");

  const accounts = await prisma.igAccount.findMany({
    where: { ownerId: session.user.id },
    orderBy: { createdAt: "asc" },
  });

  return (
    <main>
      <h1>Accounts</h1>
      {accounts.length === 0 ? (
        <p>No accounts connected yet.</p>
      ) : (
        <ul>
          {accounts.map((account) => (
            <li key={account.id}>
              @{account.username} · {account.accountType} · {account.status}
            </li>
          ))}
        </ul>
      )}
      <a href="/api/ig/connect">Connect an Instagram account</a>
      {mockConnectEnabled(process.env) ? (
        <form method="post" action="/api/ig/dev-connect">
          <button type="submit">Add a mock account (IG_MOCK)</button>
        </form>
      ) : null}
    </main>
  );
}

export default function AccountsPage() {
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <AccountList />
    </Suspense>
  );
}
