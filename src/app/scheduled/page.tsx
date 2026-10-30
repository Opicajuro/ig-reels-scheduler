import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import type { PostStatus } from "@/generated/prisma/enums";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ExternalLink } from "@/components/platform-links";
import { PostList } from "@/components/post-list";
import { linksByClip } from "@/lib/links";
import { describePostError } from "@/lib/meta-errors";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { CancelPostForm, RetryPostForm } from "./post-actions";
import { PostCalendar } from "./post-calendar";
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
  const { tab: tabParam, view } = await searchParams;
  const tab = TABS.find((candidate) => candidate.id === tabParam) ?? TABS[0];
  const calendar = view === "calendar";
  const ownerId = await getOwnerId();

  const [counts, posts] = await Promise.all([
    prisma.post.groupBy({ by: ["status"], where: { account: { ownerId } }, _count: true }),
    prisma.post.findMany({
      where: { status: { in: tab.statuses }, account: { ownerId } },
      // Upcoming posts soonest first; finished ones newest first.
      orderBy: { scheduledAt: tab.id === "upcoming" || tab.id === "publishing" ? "asc" : "desc" },
      include: {
        account: { select: { username: true } },
        media: { select: { sourceClipId: true } },
        attemptLogs: { where: { errorCode: { not: null } }, orderBy: { at: "desc" }, take: 1 },
      },
    }),
  ]);
  // Where each post's clip was also posted, outside Localirs.
  const elsewhere = await linksByClip(
    prisma,
    posts.flatMap((post) => (post.media.sourceClipId ? [post.media.sourceClipId] : [])),
  );
  const countOf = (statuses: PostStatus[]) =>
    counts.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count, 0);

  return (
    <main>
      <PageHeader title="Scheduled" description="Your Instagram posts: what is coming up, what went out and what failed." />
      <nav className={styles.views} aria-label="View">
        {[
          { id: "list", label: "List", on: !calendar },
          { id: "calendar", label: "Calendar", on: calendar },
        ].map((option) => (
          <Link
            key={option.id}
            href={`/scheduled?tab=${tab.id}${option.id === "calendar" ? "&view=calendar" : ""}`}
            className={option.on ? styles.active : undefined}
            aria-current={option.on ? "page" : undefined}
          >
            {option.label}
          </Link>
        ))}
      </nav>
      <nav className={styles.tabs} aria-label="Post status">
        {TABS.map((candidate) => (
          <Link
            key={candidate.id}
            href={`/scheduled?tab=${candidate.id}${calendar ? "&view=calendar" : ""}`}
            className={candidate.id === tab.id ? styles.active : undefined}
            aria-current={candidate.id === tab.id ? "page" : undefined}
          >
            {candidate.label} <span className={styles.count}>{countOf(candidate.statuses)}</span>
          </Link>
        ))}
      </nav>

      {posts.length === 0 ? (
        <EmptyState>{tab.empty}</EmptyState>
      ) : calendar ? (
        <PostCalendar
          now={new Date().toISOString()}
          posts={posts.map((post) => ({
            id: post.id,
            scheduledAt: post.scheduledAt.toISOString(),
            status: post.status,
            username: post.account.username,
            caption: post.caption,
          }))}
        />
      ) : (
        <PostList
          posts={posts.map((post) => ({
            ...post,
            elsewhere: post.media.sourceClipId ? elsewhere.get(post.media.sourceClipId) : undefined,
            details:
              post.status === "failed" ? (
                <p className={styles.error}>{describePostError(post.lastError, post.attemptLogs[0]?.errorCode ?? null)}</p>
              ) : post.status === "published" && post.permalink ? (
                <ExternalLink href={post.permalink} className={styles.permalink}>
                  View on Instagram
                </ExternalLink>
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
