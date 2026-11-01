import type { YtPost } from "@/generated/prisma/client";
import { AiBadge } from "@/components/ai-badge";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { ExternalLink, PlatformChips } from "@/components/platform-links";
import { StatusBadge } from "@/components/status-badge";
import { insightTable } from "@/lib/insights";
import { linksByClip } from "@/lib/links";
import { prisma } from "@/lib/prisma";
import { presignDownload } from "@/lib/storage";
import { CancelPostForm, RetryPostForm } from "../../scheduled/post-actions";
import { InsightsTable } from "./insights-table";
import styles from "./post.module.css";

const VIDEO_LINK_SECONDS = 3600;
const PRIVACY = { public: "Public", unlisted: "Unlisted", private: "Private" } as const;

// The page of a YouTube post: what is uploaded, where it went and its view, like and comment counts.
export async function YouTubePost({
  post,
}: {
  post: YtPost & { ytAccount: { channelTitle: string }; insights: Array<{ metric: string; value: number; fetchedAt: Date }> };
}) {
  const videoUrl = await presignDownload(post.videoKey, VIDEO_LINK_SECONDS);
  const elsewhere = post.sourceClipId ? ((await linksByClip(prisma, [post.sourceClipId])).get(post.sourceClipId) ?? []) : [];

  return (
    <main>
      <PageHeader
        title={`YouTube Short to ${post.ytAccount.channelTitle}`}
        description={
          <>
            Publish time: <LocalTime date={post.scheduledAt} />
          </>
        }
        actions={
          <>
            <StatusBadge status={post.status} label={post.status === "container_created" ? "Uploading" : undefined} />
            {post.aiGenerated ? <AiBadge title="Disclosed to YouTube as altered or synthetic content" /> : null}
            {post.status === "scheduled" ? <CancelPostForm postId={post.id} youtube /> : null}
            {post.status === "failed" ? <RetryPostForm postId={post.id} youtube /> : null}
          </>
        }
      />
      {post.status === "failed" ? <Alert tone="error">{post.lastError ?? "Failed for an unknown reason."}</Alert> : null}

      <div className={styles.layout}>
        <video className={styles.video} src={videoUrl} controls preload="metadata" />
        <Card>
          <dl className={styles.facts}>
            <dt>Channel</dt>
            <dd>{post.ytAccount.channelTitle}</dd>
            <dt>Title</dt>
            <dd>{post.title}</dd>
            <dt>Description</dt>
            <dd className={styles.caption}>{post.description}</dd>
            <dt>Privacy</dt>
            <dd>{PRIVACY[post.privacy]}</dd>
            <dt>Made for kids</dt>
            <dd>{post.madeForKids ? "Yes" : "No"}</dd>
            <dt>Altered or synthetic content</dt>
            <dd>{post.aiGenerated ? "Yes, disclosed to YouTube" : "No"}</dd>
            {post.url ? (
              <>
                <dt>On YouTube</dt>
                <dd>
                  <ExternalLink href={post.url}>{post.url}</ExternalLink>
                </dd>
              </>
            ) : null}
            {elsewhere.length > 0 ? (
              <>
                <dt>Posted elsewhere</dt>
                <dd>
                  <PlatformChips links={elsewhere} />
                </dd>
              </>
            ) : null}
          </dl>
        </Card>
      </div>

      <h2>Views and likes</h2>
      <InsightsTable insights={insightTable(post.insights)} />
    </main>
  );
}
