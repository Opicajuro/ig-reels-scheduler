import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { mockConnectEnabled } from "@/lib/mock-accounts";
import { ConfirmForm } from "../clips/confirm-form";
import { disconnectAccountAction, pauseAccountAction, resumeAccountAction } from "./actions";
import { prisma } from "@/lib/prisma";
import { Button, ButtonLink } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Accounts" };

async function AccountList() {
  await connection();
  const ownerId = await getOwnerId();

  const accounts = await prisma.igAccount.findMany({
    where: { ownerId: ownerId },
    orderBy: { createdAt: "asc" },
  });
  const now = new Date();

  return (
    <main>
      <PageHeader title="Accounts" />
      {accounts.length === 0 ? (
        <EmptyState>No accounts connected yet.</EmptyState>
      ) : (
        <ul>
          {accounts.map((account) => (
            <li key={account.id}>
              @{account.username} · {account.accountType} · {account.status}
              {account.pausedUntil && account.pausedUntil > now ? (
                <>
                  {" "}
                  · paused until <LocalTime date={account.pausedUntil} />
                  <form action={resumeAccountAction}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <Button type="submit">Resume</Button>
                  </form>
                </>
              ) : (
                <form action={pauseAccountAction}>
                  <input type="hidden" name="accountId" value={account.id} />
                  <input type="hidden" name="minutes" value="60" />
                  <Button type="submit">Pause 1h</Button>
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
      <ButtonLink href="/api/ig/connect" variant="primary">
        Connect an Instagram account
      </ButtonLink>
      {mockConnectEnabled(process.env) ? (
        <form method="post" action="/api/ig/dev-connect">
          <Button type="submit">Add a mock account (IG_MOCK)</Button>
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
