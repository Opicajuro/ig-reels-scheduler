import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { mockConnectEnabled } from "@/lib/mock-accounts";
import { ConfirmForm } from "../clips/confirm-form";
import { disconnectAccountAction, pauseAccountAction, resumeAccountAction } from "./actions";
import { prisma } from "@/lib/prisma";

async function AccountList() {
  await connection();
  const session = await auth();
  if (!session?.user) redirect("/login");

  const accounts = await prisma.igAccount.findMany({
    where: { ownerId: session.user.id },
    orderBy: { createdAt: "asc" },
  });
  const now = new Date();

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
              {account.pausedUntil && account.pausedUntil > now ? (
                <>
                  {" "}
                  · paused until {account.pausedUntil.toISOString().slice(0, 16).replace("T", " ")} UTC
                  <form action={resumeAccountAction}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <button type="submit">Resume</button>
                  </form>
                </>
              ) : (
                <form action={pauseAccountAction}>
                  <input type="hidden" name="accountId" value={account.id} />
                  <input type="hidden" name="minutes" value="60" />
                  <button type="submit">Pause 1h</button>
                </form>
              )}
              {account.status === "active" ? (
                <ConfirmForm
                  action={disconnectAccountAction}
                  message={`Disconnect @${account.username}? Its scheduled posts will be canceled.`}
                  fields={{ accountId: account.id }}
                >
                  Disconnect
                </ConfirmForm>
              ) : null}
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
