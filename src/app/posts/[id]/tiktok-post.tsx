import type { TtPost } from "@/generated/prisma/client";
import { AiBadge } from "@/components/ai-badge";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { PlatformChips } from "@/components/platform-links";
import { StatusBadge } from "@/components/status-badge";
import { linksByClip } from "@/lib/links";
import { prisma } from "@/lib/prisma";
import { presignDownload } from "@/lib/storage";
import { TIKTOK_SENT, TIKTOK_SENT_LONG } from "@/lib/tiktok";
import { CancelPostForm, RetryPostForm } from "../../scheduled/post-actions";
import styles from "./post.module.css";

const VIDEO_LINK_SECONDS = 3600;

// The page of a TikTok draft: what is sent to the inbox, and the caption to paste when posting it in the TikTok app.
export async function TikTokPost({ post }: { post: TtPost & { ttAccount: { displayName: string } } }) {
  const videoUrl = await presignDownload(post.videoKey, VIDEO_LINK_SECONDS);
  const elsewhere = post.sourceClipId ? ((await linksByClip(prisma, [post.sourceClipId])).get(post.sourceClipId) ?? []) : [];
  const label = post.status === "published" ? TIKTOK_SENT : post.status === "container_created" ? "Uploading" : undefined;

  return (
    <main>
      <PageHeader
        title={`TikTok draft to ${post.ttAccount.displayName}`}
        description={
          <>
            Sent at: <LocalTime date={post.scheduledAt} />
          </>
        }
        actions={
          <>
            <StatusBadge status={post.status} label={label} />
            {post.aiGenerated ? <AiBadge title="Turn on TikTok's AI-generated label when you post the draft" /> : null}
            {post.status === "scheduled" ? <CancelPostForm postId={post.id} platform="tiktok" /> : null}
            {post.status === "failed" ? <RetryPostForm postId={post.id} platform="tiktok" /> : null}
          </>
        }
      />
      {post.status === "failed" ? <Alert tone="error">{post.lastError ?? "Failed for an unknown reason."}</Alert> : null}
      {post.status === "published" ? (
        <Alert tone="info">
          {TIKTOK_SENT_LONG} Open the inbox notification in TikTok, add the caption and post it.
        </Alert>
      ) : null}

      <div className={styles.layout}>
        <video className={styles.video} src={videoUrl} controls preload="metadata" />
        <Card>
          <dl className={styles.facts}>
            <dt>Account</dt>
            <dd>{post.ttAccount.displayName}</dd>
            <dt>Caption to paste</dt>
            <dd className={styles.caption}>{post.caption || "No caption"}</dd>
            <dt>Made with AI</dt>
            <dd>
              {post.aiGenerated
                ? "Yes. TikTok's draft upload has no AI flag: turn on the AI-generated content setting when you post it."
                : "No"}
            </dd>
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
