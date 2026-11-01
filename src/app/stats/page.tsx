import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { loadPublishedStats } from "@/lib/published-stats";
import { StatsView } from "./stats-view";

export const metadata: Metadata = { title: "Stats" };

export default async function StatsPage() {
  await connection();
  const ownerId = await getOwnerId();
  const posts = await loadPublishedStats(prisma, ownerId);
  const accounts = [...new Map(posts.map((post) => [post.accountId, post.username])).entries()]
    .map(([id, username]) => ({ id, username }))
    .sort((a, b) => a.username.localeCompare(b.username));

  return (
    <main>
      <PageHeader
        title="Stats"
        description="How your published Reels did, from each post's latest insights, and the best time to post."
      />
      {posts.length === 0 ? (
        <EmptyState>
          Nothing has been published yet. Once a post is out, its insights are pulled 1 hour, 24 hours and 7 days later and
          show up here. <Link href="/clips">Schedule a clip</Link>
        </EmptyState>
      ) : (
        <StatsView
          accounts={accounts}
          posts={posts.map((post) => ({ ...post, publishedAt: post.publishedAt.toISOString() }))}
        />
      )}
    </main>
  );
}
