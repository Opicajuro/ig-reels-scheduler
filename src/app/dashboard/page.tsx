import type { Metadata } from "next";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { cancelPostAction, retryPostAction } from "./actions";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  await connection();
  const ownerId = await getOwnerId();

  const [accounts, scheduled, failed] = await Promise.all([
    prisma.igAccount.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } }),
    prisma.post.findMany({
      where: { status: "scheduled", account: { ownerId } },
      orderBy: { scheduledAt: "asc" },
    }),
    prisma.post.findMany({
      where: { status: "failed", account: { ownerId } },
      orderBy: { scheduledAt: "desc" },
    }),
  ]);

  return (
    <main>
      <PageHeader title="Dashboard" />

      <h2>Accounts</h2>
      {accounts.length === 0 ? (
        <EmptyState>No accounts connected yet.</EmptyState>
      ) : (
        <ul>
          {accounts.map((account) => (
            <li key={account.id}>
              @{account.username} · {account.accountType} · {account.status}
            </li>
          ))}
        </ul>
      )}

      <h2>Failed posts</h2>
      {failed.length === 0 ? (
        <EmptyState>Nothing failed.</EmptyState>
      ) : (
        <ul>
          {failed.map((post) => (
            <li key={post.id}>
              <LocalTime date={post.scheduledAt} /> · {post.lastError ?? "unknown error"}
              <ActionForm action={retryPostAction}>
                <input type="hidden" name="postId" value={post.id} />
                <SubmitButton pendingLabel="Retrying…">Retry</SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}

      <h2>Scheduled</h2>
      {scheduled.length === 0 ? (
        <EmptyState>Nothing scheduled.</EmptyState>
      ) : (
        <ul>
          {scheduled.map((post) => (
            <li key={post.id}>
              <LocalTime date={post.scheduledAt} /> · {post.caption.slice(0, 60)}
              <ActionForm
                action={cancelPostAction}
                confirm={{ message: "Cancel this post? It will not be published.", confirmLabel: "Cancel post" }}
              >
                <input type="hidden" name="postId" value={post.id} />
                <SubmitButton variant="danger" pendingLabel="Canceling…">
                  Cancel
                </SubmitButton>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
