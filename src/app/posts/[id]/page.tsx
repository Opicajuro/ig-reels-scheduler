import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";

export const metadata: Metadata = { title: "Post" };

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const ownerId = await getOwnerId();

  const post = await prisma.post.findFirst({
    where: { id, account: { ownerId: ownerId } },
    include: { insights: { orderBy: { fetchedAt: "desc" } } },
  });
  if (!post) notFound();

  const latest = new Map<string, number>();
  for (const insight of post.insights) {
    if (!latest.has(insight.metric)) latest.set(insight.metric, insight.value);
  }

  return (
    <main>
      <PageHeader title="Post" actions={<StatusBadge status={post.status} />} />
      <p>
        Publish time: <LocalTime date={post.scheduledAt} />
      </p>
      <p>Caption: {post.caption}</p>
      {post.permalink ? (
        <p>
          <a href={post.permalink}>View on Instagram</a>
        </p>
      ) : null}
      <h2>Insights</h2>
      {latest.size === 0 ? (
        <EmptyState>No insights yet. They are pulled 1 hour, 24 hours and 7 days after publishing.</EmptyState>
      ) : (
        <ul>
          {[...latest.entries()].map(([metric, value]) => (
            <li key={metric}>
              {metric}: {value}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
