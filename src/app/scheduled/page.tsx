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
import { TIKTOK_SENT, TIKTOK_SENT_LONG } from "@/lib/tiktok";
import { CancelPostForm, RetryPostForm } from "./post-actions";
import { PostCalendar } from "./post-calendar";
import styles from "./scheduled.module.css";

export const metadata: Metadata = { title: "Scheduled" };

// Upcoming holds everything not yet published, including posts in their last 45 minutes, which are also under
// Publishing while Instagram prepares the video, and YouTube posts while they upload.
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

  const order = tab.id === "upcoming" || tab.id === "publishing" ? "asc" : "desc";
  const [counts, ytCounts, fbCounts, ttCounts, igPosts, ytPosts, fbPosts, ttPosts] = await Promise.all([
    prisma.post.groupBy({ by: ["status"], where: { account: { ownerId } }, _count: true }),
    prisma.ytPost.groupBy({ by: ["status"], where: { ytAccount: { ownerId } }, _count: true }),
    prisma.fbPost.groupBy({ by: ["status"], where: { fbPage: { ownerId } }, _count: true }),
    prisma.ttPost.groupBy({ by: ["status"], where: { ttAccount: { ownerId } }, _count: true }),
    prisma.post.findMany({
      where: { status: { in: tab.statuses }, account: { ownerId } },
      // Upcoming posts soonest first; finished ones newest first.
      orderBy: { scheduledAt: order },
      include: {
        account: { select: { username: true } },
        media: { select: { sourceClipId: true } },
        attemptLogs: { where: { errorCode: { not: null } }, orderBy: { at: "desc" }, take: 1 },
      },
    }),
    prisma.ytPost.findMany({
      where: { status: { in: tab.statuses }, ytAccount: { ownerId } },
      orderBy: { scheduledAt: order },
      include: { ytAccount: { select: { channelTitle: true } } },
    }),
    prisma.fbPost.findMany({
      where: { status: { in: tab.statuses }, fbPage: { ownerId } },
      orderBy: { scheduledAt: order },
      include: { fbPage: { select: { name: true } } },
    }),
    prisma.ttPost.findMany({
      where: { status: { in: tab.statuses }, ttAccount: { ownerId } },
      orderBy: { scheduledAt: order },
      include: { ttAccount: { select: { displayName: true } } },
    }),
  ]);
  // Where each post's clip was also posted, outside Localirs.
  const elsewhere = await linksByClip(
    prisma,
    [
      ...igPosts.map((post) => post.media.sourceClipId),
      ...[...ytPosts, ...fbPosts, ...ttPosts].map((post) => post.sourceClipId),
    ].flatMap((id) => (id ? [id] : [])),
  );
  const posts = [
    ...igPosts.map((post) => ({
      id: post.id,
      scheduledAt: post.scheduledAt,
      status: post.status,
      caption: post.caption,
      aiGenerated: post.aiGenerated,
      destination: `@${post.account.username}`,
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
    })),
    ...ytPosts.map((post) => ({
      id: post.id,
      scheduledAt: post.scheduledAt,
      status: post.status,
      caption: post.title,
      aiGenerated: post.aiGenerated,
      aiTitle: "Disclosed to YouTube as altered or synthetic content",
      destination: `YouTube: ${post.ytAccount.channelTitle}`,
      elsewhere: post.sourceClipId ? elsewhere.get(post.sourceClipId) : undefined,
      details:
        post.status === "failed" ? (
          <p className={styles.error}>{post.lastError ?? "Failed for an unknown reason."}</p>
        ) : post.status === "published" && post.url ? (
          <ExternalLink href={post.url} className={styles.permalink}>
            View on YouTube
          </ExternalLink>
        ) : null,
      actions:
        post.status === "scheduled" ? (
          <CancelPostForm postId={post.id} platform="youtube" />
        ) : post.status === "failed" ? (
          <RetryPostForm postId={post.id} platform="youtube" />
        ) : null,
    })),
    ...fbPosts.map((post) => ({
      id: post.id,
      scheduledAt: post.scheduledAt,
      status: post.status,
      caption: post.description,
      aiGenerated: post.aiGenerated,
      aiTitle: "Published with Facebook's AI-generated flag",
      destination: `Facebook: ${post.fbPage.name}`,
      elsewhere: post.sourceClipId ? elsewhere.get(post.sourceClipId) : undefined,
      details:
        post.status === "failed" ? (
          <p className={styles.error}>{post.lastError ?? "Failed for an unknown reason."}</p>
        ) : post.status === "published" && post.permalink ? (
          <ExternalLink href={post.permalink} className={styles.permalink}>
            View on Facebook
          </ExternalLink>
        ) : null,
      actions:
        post.status === "scheduled" ? (
          <CancelPostForm postId={post.id} platform="facebook" />
        ) : post.status === "failed" ? (
          <RetryPostForm postId={post.id} platform="facebook" />
        ) : null,
    })),
    ...ttPosts.map((post) => ({
      id: post.id,
      scheduledAt: post.scheduledAt,
      status: post.status,
      statusLabel: post.status === "published" ? TIKTOK_SENT : post.status === "container_created" ? "Uploading" : undefined,
      caption: post.caption,
      aiGenerated: post.aiGenerated,
      aiTitle: "Turn on TikTok's AI-generated label when you post the draft",
      destination: `TikTok (draft): ${post.ttAccount.displayName}`,
      elsewhere: post.sourceClipId ? elsewhere.get(post.sourceClipId) : undefined,
      details:
        post.status === "failed" ? (
          <p className={styles.error}>{post.lastError ?? "Failed for an unknown reason."}</p>
        ) : post.status === "published" ? (
          <p>{TIKTOK_SENT_LONG}</p>
        ) : null,
      actions:
        post.status === "scheduled" ? (
          <CancelPostForm postId={post.id} platform="tiktok" />
        ) : post.status === "failed" ? (
          <RetryPostForm postId={post.id} platform="tiktok" />
        ) : null,
    })),
  ].sort((a, b) => (order === "asc" ? 1 : -1) * (a.scheduledAt.getTime() - b.scheduledAt.getTime()));
  const countOf = (statuses: PostStatus[]) =>
    [...counts, ...ytCounts, ...fbCounts, ...ttCounts].filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count, 0);

  return (
    <main>
      <PageHeader title="Scheduled" description="Your Instagram, YouTube, Facebook and TikTok posts: what is coming up, what went out and what failed." />
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
            destination: post.destination,
            caption: post.caption,
          }))}
        />
      ) : (
        <PostList posts={posts} />
      )}
    </main>
  );
}
