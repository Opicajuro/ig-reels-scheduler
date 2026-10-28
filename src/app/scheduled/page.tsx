import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import type { PostStatus } from "@/generated/prisma/enums";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PostList } from "@/components/post-list";
import { describePostError } from "@/lib/meta-errors";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { CancelPostForm, RetryPostForm } from "./post-actions";
import styles from "./scheduled.module.css";

export const metadata: Metadata = { title: "Scheduled" };

// Upcoming holds everything not yet published, including posts in their last 45 minutes, which are also under
// Publishing while Instagram prepares the video.
const TABS = [
  { id: "upcoming", label: "Upcoming", statuses: ["scheduled", "container_created"], empty: "Nothing is scheduled." },
  { id: "publishing", label: "Publishing", statuses: ["container_created"], empty: "Nothing is being published right now." },
  { id: "published", label: "Published", statuses: ["published"], empty: "Nothing has been published yet." },
  { id: "failed", label: "Failed", statuses: ["failed"], empty: "Nothing failed." },
  { id: "canceled", label: "Canceled", statuses: ["canceled"], empty: "Nothing was canceled." },
] satisfies Array<{ id: string; label: string; statuses: PostStatus[]; empty: string }>;

export default async function ScheduledPage({ searchParams }: PageProps<"/scheduled">) {
  await connection();
  const { tab: tabParam } = await searchParams;
  const tab = TABS.find((candidate) => candidate.id === tabParam) ?? TABS[0];
  const ownerId = await getOwnerId();

  const [counts, posts] = await Promise.all([
    prisma.post.groupBy({ by: ["status"], where: { account: { ownerId } }, _count: true }),
    prisma.post.findMany({
      where: { status: { in: tab.statuses }, account: { ownerId } },
      // Upcoming posts soonest first; finished ones newest first.
      orderBy: { scheduledAt: tab.id === "upcoming" || tab.id === "publishing" ? "asc" : "desc" },
      include: {
        account: { select: { username: true } },
        attemptLogs: { where: { errorCode: { not: null } }, orderBy: { at: "desc" }, take: 1 },
      },
    }),
  ]);
  const countOf = (statuses: PostStatus[]) =>
    counts.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count, 0);

  return (
    <main>
      <PageHeader title="Scheduled" description="Your Instagram posts: what is coming up, what went out and what failed." />
      <nav className={styles.tabs} aria-label="Post status">
        {TABS.map((candidate) => (
          <Link
            key={candidate.id}
            href={`/scheduled?tab=${candidate.id}`}
            className={candidate.id === tab.id ? styles.active : undefined}
            aria-current={candidate.id === tab.id ? "page" : undefined}
          >
            {candidate.label} <span className={styles.count}>{countOf(candidate.statuses)}</span>
          </Link>
        ))}
      </nav>

      {posts.length === 0 ? (
        <EmptyState>{tab.empty}</EmptyState>
      ) : (
        <PostList
          posts={posts.map((post) => ({
            ...post,
            details:
              post.status === "failed" ? (
                <p className={styles.error}>{describePostError(post.lastError, post.attemptLogs[0]?.errorCode ?? null)}</p>
              ) : post.status === "published" && post.permalink ? (
                <a href={post.permalink} className={styles.permalink}>
                  View on Instagram
                </a>
              ) : null,
            actions:
              post.status === "scheduled" || post.status === "container_created" ? (
                <CancelPostForm postId={post.id} />
              ) : post.status === "failed" ? (
                <RetryPostForm postId={post.id} />
              ) : null,
          }))}
        />
      )}
    </main>
  );
}
