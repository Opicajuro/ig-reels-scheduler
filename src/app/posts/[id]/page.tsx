import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

async function PostDetail({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const post = await prisma.post.findFirst({
    where: { id, account: { ownerId: session.user.id } },
    include: { insights: { orderBy: { fetchedAt: "desc" } } },
  });
  if (!post) return <main>Post not found.</main>;

  const latest = new Map<string, number>();
  for (const insight of post.insights) {
    if (!latest.has(insight.metric)) latest.set(insight.metric, insight.value);
  }

  return (
    <main>
      <h1>Post</h1>
      <p>Status: {post.status}</p>
      <p>Publish time: {post.scheduledAt.toISOString()}</p>
      <p>Caption: {post.caption}</p>
      {post.permalink ? (
        <p>
          <a href={post.permalink}>View on Instagram</a>
        </p>
      ) : null}
      <h2>Insights</h2>
      {latest.size === 0 ? (
        <p>No insights yet. They are pulled 1 hour, 24 hours and 7 days after publishing.</p>
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

export default function PostPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <PostDetail params={params} />
    </Suspense>
  );
}
