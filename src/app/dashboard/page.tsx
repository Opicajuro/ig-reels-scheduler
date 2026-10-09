import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { cancelScheduledPost } from "@/lib/posts";
import { retryFailedPost } from "@/lib/post-retry";
import { getPublishQueue } from "@/lib/queues";

async function Dashboard() {
  await connection();
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const ownerId = session.user.id;

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
    const current = await auth();
    if (!current?.user?.id) redirect("/login");
    await retryFailedPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: current.user.id,
      postId: String(formData.get("postId")),
      now: new Date(),
    });
    redirect("/dashboard");
  }

  async function cancel(formData: FormData) {
    "use server";
    const current = await auth();
    if (!current?.user?.id) redirect("/login");
    await cancelScheduledPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: current.user.id,
      postId: String(formData.get("postId")),
    });
    redirect("/dashboard");
  }

  return (
    <main>
      <h1>Dashboard</h1>

      <h2>Accounts</h2>
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

      <h2>Failed posts</h2>
      {failed.length === 0 ? (
        <p>Nothing failed.</p>
      ) : (
        <ul>
          {failed.map((post) => (
            <li key={post.id}>
              {post.scheduledAt.toISOString()} · {post.lastError ?? "unknown error"}
              <form action={retry}>
                <input type="hidden" name="postId" value={post.id} />
                <button type="submit">Retry</button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <h2>Scheduled</h2>
      {scheduled.length === 0 ? (
        <p>Nothing scheduled.</p>
      ) : (
        <ul>
          {scheduled.map((post) => (
            <li key={post.id}>
              {post.scheduledAt.toISOString()} · {post.caption.slice(0, 60)}
              <form action={cancel}>
                <input type="hidden" name="postId" value={post.id} />
                <button type="submit">Cancel</button>
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
