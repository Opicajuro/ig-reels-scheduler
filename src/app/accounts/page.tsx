import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { PAUSE_OPTIONS } from "@/lib/account-management";
import { metaAppConfig } from "@/lib/ig-connect";
import { mockConnectEnabled } from "@/lib/mock-accounts";
import { getSettings } from "@/lib/settings";
import { disconnectAccountAction, pauseAccountAction, resumeAccountAction } from "./actions";
import { prisma } from "@/lib/prisma";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Button, ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import styles from "./accounts.module.css";

export const metadata: Metadata = { title: "Accounts" };

const STATUS_TEXT = { active: "Connected", reauth_required: "Needs reconnecting", revoked: "Disconnected" } as const;

export default async function AccountsPage() {
  await connection();
  const ownerId = await getOwnerId();

  const [accounts, settings] = await Promise.all([
    prisma.igAccount.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" }, include: { token: true } }),
    getSettings(prisma),
  ]);
  const metaReady = metaAppConfig(settings, process.env.IG_REDIRECT_URI) !== null;
  const now = new Date();

  return (
    <main>
      <PageHeader
        title="Accounts"
        description="The Instagram accounts Localirs publishes to."
        actions={
          metaReady ? (
            <ButtonLink href="/api/ig/connect" variant="primary">
              Connect an Instagram account
            </ButtonLink>
          ) : null
        }
      />
      {metaReady ? null : (
        <Alert tone="info">
          Connecting Instagram needs a Meta app, and none is set up yet. Add its app ID and secret on the{" "}
          <Link href="/settings">Settings</Link> page. Making and downloading clips works without one.
        </Alert>
      )}
      {accounts.length === 0 ? (
        <EmptyState>No accounts connected yet.</EmptyState>
      ) : (
        <ul className={styles.list}>
          {accounts.map((account) => {
            const expired = account.token !== null && account.token.expiresAt <= now;
            const needsReconnect = account.status === "reauth_required" || (account.status === "active" && expired);
            const pausedByYou = account.pausedUntil && account.pausedUntil > now ? account.pausedUntil : null;
            const rateLimited =
              account.rateLimitedUntil && account.rateLimitedUntil > now ? account.rateLimitedUntil : null;
            return (
              <li key={account.id}>
                <Card>
                  <div className={styles.head}>
                    <h2>@{account.username}</h2>
                    <span className={needsReconnect ? styles.warning : styles.muted}>
                      {needsReconnect ? STATUS_TEXT.reauth_required : STATUS_TEXT[account.status]} ·{" "}
                      {account.accountType === "MEDIA_CREATOR" ? "Creator" : "Business"}
                    </span>
                  </div>
                  <dl className={styles.facts}>
                    <dt>Login {expired ? "expired" : "expires"}</dt>
                    <dd>{account.token ? <LocalTime date={account.token.expiresAt} /> : "No login stored"}</dd>
                    {rateLimited ? (
                      <>
                        <dt>Instagram rate limit</dt>
                        <dd>
                          Publishing waits until <LocalTime date={rateLimited} />. Instagram asked for this pause; it
                          ends on its own.
                        </dd>
                      </>
                    ) : null}
                    {pausedByYou ? (
                      <>
                        <dt>Paused by you</dt>
                        <dd>
                          Until <LocalTime date={pausedByYou} />
                        </dd>
                      </>
                    ) : null}
                  </dl>
                  <div className={styles.actions}>
                    {needsReconnect ? (
                      metaReady ? (
                        <ButtonLink href="/api/ig/connect" variant="primary" size="sm">
                          Reconnect
                        </ButtonLink>
                      ) : (
                        <Link href="/settings">Set up the Meta app to reconnect</Link>
                      )
                    ) : null}
                    {account.status === "active" ? (
                      pausedByYou ? (
                        <ActionForm action={resumeAccountAction}>
                          <input type="hidden" name="accountId" value={account.id} />
                          <SubmitButton size="sm" pendingLabel="Resuming…">
                            Resume
                          </SubmitButton>
                        </ActionForm>
                      ) : (
                        <ActionForm action={pauseAccountAction} className={styles.pause}>
                          <input type="hidden" name="accountId" value={account.id} />
                          <select name="minutes" aria-label="Pause for" defaultValue={PAUSE_OPTIONS[0].minutes}>
                            {PAUSE_OPTIONS.map((option) => (
                              <option key={option.minutes} value={option.minutes}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <SubmitButton size="sm" pendingLabel="Pausing…">
                            Pause
                          </SubmitButton>
                        </ActionForm>
                      )
                    ) : null}
                    {account.status === "active" ? (
                      <ActionForm
                        action={disconnectAccountAction}
                        confirm={{
                          message: `Disconnect @${account.username}? Its scheduled posts will be canceled.`,
                          confirmLabel: "Disconnect",
                        }}
                      >
                        <input type="hidden" name="accountId" value={account.id} />
                        <SubmitButton variant="danger" size="sm" pendingLabel="Disconnecting…">
                          Disconnect
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      {mockConnectEnabled(process.env) ? (
        <form method="post" action="/api/ig/dev-connect">
          <Button type="submit">Add a mock account (IG_MOCK)</Button>
        </form>
      ) : null}
    </main>
  );
}
