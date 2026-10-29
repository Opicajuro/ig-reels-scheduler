import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { AttemptStep } from "@/generated/prisma/enums";
import { AiBadge } from "@/components/ai-badge";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { insightTable } from "@/lib/insights";
import { describePostError } from "@/lib/meta-errors";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { presignDownload } from "@/lib/storage";
import { CancelPostForm, RetryPostForm } from "../../scheduled/post-actions";
import { InsightBars } from "./insight-bars";
import styles from "./post.module.css";

export const metadata: Metadata = { title: "Post" };

const VIDEO_LINK_SECONDS = 3600;

// What each logged publish step means, when it worked and when it did not.
const STEPS: Record<AttemptStep, { done: string; failed: string }> = {
  create: { done: "Sent the video to Instagram", failed: "Sending the video to Instagram failed" },
  poll: { done: "Instagram finished preparing the video", failed: "Instagram could not prepare the video" },
  quota: { done: "Checked the daily publishing limit", failed: "Checking the daily publishing limit failed" },
  publish: { done: "Published on Instagram", failed: "Publishing failed" },
};

export default async function PostPage({ params }: PageProps<"/posts/[id]">) {
  await connection();
  const { id } = await params;
  const ownerId = await getOwnerId();

  const post = await prisma.post.findFirst({
    where: { id, account: { ownerId } },
    include: {
      account: { select: { username: true } },
      media: { select: { reelKey: true } },
      attemptLogs: { orderBy: { at: "asc" } },
      insights: true,
    },
  });
  if (!post) notFound();

  const videoUrl = post.media.reelKey ? await presignDownload(post.media.reelKey, VIDEO_LINK_SECONDS) : null;
  const lastCode = post.attemptLogs.findLast((attempt) => attempt.errorCode !== null)?.errorCode ?? null;
  const insights = insightTable(post.insights);
  const open = post.status === "scheduled" || post.status === "container_created";

  return (
    <main>
      <PageHeader
        title={`Post to @${post.account.username}`}
        description={
          <>
            Publish time: <LocalTime date={post.scheduledAt} />
          </>
        }
        actions={
          <>
            <StatusBadge status={post.status} />
            {post.aiGenerated ? <AiBadge title="Posted with Instagram's AI info label" /> : null}
            {open ? <CancelPostForm postId={post.id} /> : null}
            {post.status === "failed" ? <RetryPostForm postId={post.id} /> : null}
          </>
        }
      />
      {post.status === "failed" ? <Alert tone="error">{describePostError(post.lastError, lastCode)}</Alert> : null}

      <div className={styles.layout}>
        {videoUrl ? (
          <video className={styles.video} src={videoUrl} controls preload="metadata" />
        ) : (
          <EmptyState>The video is still being prepared.</EmptyState>
        )}
        <Card>
          <dl className={styles.facts}>
            <dt>Account</dt>
            <dd>@{post.account.username}</dd>
            <dt>Caption</dt>
            <dd className={styles.caption}>{post.caption || "No caption"}</dd>
            <dt>Shown in the feed</dt>
            <dd>{post.shareToFeed ? "Yes" : "No, only under Reels"}</dd>
            <dt>AI info label</dt>
            <dd>{post.aiGenerated ? "Yes, Instagram shows that it was made with AI" : "No"}</dd>
            {post.permalink ? (
              <>
                <dt>On Instagram</dt>
                <dd>
                  <a href={post.permalink}>{post.permalink}</a>
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
      </div>

      <h2>What happened</h2>
      {post.attemptLogs.length === 0 ? (
        <EmptyState>Nothing yet. Publishing starts 45 minutes before the publish time.</EmptyState>
      ) : (
        <ol className={styles.timeline}>
          {post.attemptLogs.map((attempt) => {
            const failed = attempt.httpStatus !== 200;
            const message = (attempt.response as { message?: string }).message ?? null;
            return (
              <li key={attempt.id} className={failed ? styles.failed : undefined}>
                <LocalTime date={attempt.at} />
                <strong>{failed ? STEPS[attempt.step].failed : STEPS[attempt.step].done}</strong>
                {failed ? <span>{describePostError(message, attempt.errorCode)}</span> : null}
              </li>
            );
          })}
        </ol>
      )}

      <h2>Insights</h2>
      {insights.rows.length === 0 ? (
        <EmptyState>No insights yet. They are pulled 1 hour, 24 hours and 7 days after publishing.</EmptyState>
      ) : (
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                {insights.pulls.map((pull) => (
                  <th key={pull} className={styles.number}>
                    {pull}
                  </th>
                ))}
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              {insights.rows.map((row) => (
                <tr key={row.metric}>
                  <td>{row.label}</td>
                  {row.values.map((value, index) => (
                    <td key={insights.pulls[index]} className={styles.number}>
                      {value === null ? "–" : value.toLocaleString("en")}
                    </td>
                  ))}
                  <td>
                    <InsightBars label={row.label} pulls={insights.pulls} values={row.values} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
