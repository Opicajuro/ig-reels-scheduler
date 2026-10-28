import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { cancelScheduledPost } from "@/lib/posts";
import { retryFailedPost } from "@/lib/post-retry";
import { getPublishQueue } from "@/lib/queues";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Dashboard" };

async function Dashboard() {
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

  async function retry(formData: FormData) {
    "use server";
    const ownerId = await getOwnerId();
    await retryFailedPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: ownerId,
      postId: String(formData.get("postId")),
      now: new Date(),
    });
    redirect("/dashboard");
  }

  async function cancel(formData: FormData) {
    "use server";
    const ownerId = await getOwnerId();
    await cancelScheduledPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: ownerId,
      postId: String(formData.get("postId")),
    });
    redirect("/dashboard");
  }

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
              <form action={retry}>
                <input type="hidden" name="postId" value={post.id} />
                <Button type="submit">Retry</Button>
              </form>
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
              <form action={cancel}>
                <input type="hidden" name="postId" value={post.id} />
                <Button type="submit">Cancel</Button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <Dashboard />
    </Suspense>
  );
}
