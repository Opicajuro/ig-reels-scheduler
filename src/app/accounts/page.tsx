import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
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
