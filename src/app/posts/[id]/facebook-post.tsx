import type { FbPost } from "@/generated/prisma/client";
import { AiBadge } from "@/components/ai-badge";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { ExternalLink, PlatformChips } from "@/components/platform-links";
import { StatusBadge } from "@/components/status-badge";
import { linksByClip } from "@/lib/links";
import { prisma } from "@/lib/prisma";
import { presignDownload } from "@/lib/storage";
import { CancelPostForm, RetryPostForm } from "../../scheduled/post-actions";
import styles from "./post.module.css";

const VIDEO_LINK_SECONDS = 3600;

// The page of a Facebook Reel: what is published, where, and its link on Facebook.
export async function FacebookPost({ post }: { post: FbPost & { fbPage: { name: string } } }) {
  const videoUrl = await presignDownload(post.videoKey, VIDEO_LINK_SECONDS);
  const elsewhere = post.sourceClipId ? ((await linksByClip(prisma, [post.sourceClipId])).get(post.sourceClipId) ?? []) : [];

  return (
    <main>
      <PageHeader
        title={`Facebook Reel to ${post.fbPage.name}`}
        description={
          <>
            Publish time: <LocalTime date={post.scheduledAt} />
          </>
        }
        actions={
          <>
            <StatusBadge status={post.status} />
            {post.aiGenerated ? <AiBadge title="Published with Facebook's AI-generated flag" /> : null}
            {post.status === "scheduled" ? <CancelPostForm postId={post.id} platform="facebook" /> : null}
            {post.status === "failed" ? <RetryPostForm postId={post.id} platform="facebook" /> : null}
          </>
        }
      />
      {post.status === "failed" ? <Alert tone="error">{post.lastError ?? "Failed for an unknown reason."}</Alert> : null}

      <div className={styles.layout}>
        <video className={styles.video} src={videoUrl} controls preload="metadata" />
        <Card>
          <dl className={styles.facts}>
            <dt>Page</dt>
            <dd>{post.fbPage.name}</dd>
            <dt>Description</dt>
            <dd className={styles.caption}>{post.description || "No description"}</dd>
            <dt>Made with AI</dt>
            <dd>{post.aiGenerated ? "Yes, sent to Facebook as AI-generated (is_ai_generated)" : "No"}</dd>
            {post.fbPostId ? (
              <>
                <dt>Facebook post id</dt>
                <dd>{post.fbPostId}</dd>
              </>
            ) : null}
            {post.permalink ? (
              <>
                <dt>On Facebook</dt>
                <dd>
                  <ExternalLink href={post.permalink}>{post.permalink}</ExternalLink>
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
    </main>
  );
}
