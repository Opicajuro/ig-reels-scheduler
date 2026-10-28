import type { Metadata } from "next";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { metaAppConfigured } from "@/lib/ig-connect";
import { mockConnectEnabled } from "@/lib/mock-accounts";
import { disconnectAccountAction, pauseAccountAction, resumeAccountAction } from "./actions";
import { prisma } from "@/lib/prisma";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Button, ButtonLink } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Accounts" };

export default async function AccountsPage() {
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
                  <ActionForm action={resumeAccountAction}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <SubmitButton pendingLabel="Resuming…">Resume</SubmitButton>
                  </ActionForm>
                </>
              ) : (
                <ActionForm action={pauseAccountAction}>
                  <input type="hidden" name="accountId" value={account.id} />
                  <input type="hidden" name="minutes" value="60" />
                  <SubmitButton pendingLabel="Pausing…">Pause 1h</SubmitButton>
                </ActionForm>
              )}
              {account.status === "active" ? (
                <ActionForm
                  action={disconnectAccountAction}
                  confirm={{
                    message: `Disconnect @${account.username}? Its scheduled posts will be canceled.`,
                    confirmLabel: "Disconnect",
                  }}
                >
                  <input type="hidden" name="accountId" value={account.id} />
                  <SubmitButton variant="danger" pendingLabel="Disconnecting…">
                    Disconnect
                  </SubmitButton>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {metaAppConfigured(process.env) ? (
        <ButtonLink href="/api/ig/connect" variant="primary">
          Connect an Instagram account
        </ButtonLink>
      ) : (
        <Alert tone="info">
          Connecting Instagram needs a Meta app, and none is set up yet. Add its IG_APP_ID, IG_APP_SECRET and
          IG_REDIRECT_URI to the .env file and restart Localirs. Making and downloading clips works without one.
        </Alert>
      )}
      {mockConnectEnabled(process.env) ? (
        <form method="post" action="/api/ig/dev-connect">
          <Button type="submit">Add a mock account (IG_MOCK)</Button>
        </form>
      ) : null}
    </main>
  );
}
