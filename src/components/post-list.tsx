import Link from "next/link";
import type { ReactNode } from "react";
import type { PostStatus } from "@/generated/prisma/enums";
import { AiBadge } from "./ai-badge";
import { LocalTime } from "./local-time";
import { PlatformChips } from "./platform-links";
import { StatusBadge } from "./status-badge";
import styles from "./post-list.module.css";

export type PostListItem = {
  id: string;
  scheduledAt: Date;
  status: PostStatus;
  caption: string;
  aiGenerated: boolean;
  // Where it goes, such as "@foo" or "YouTube: My channel".
  destination: string;
  // What the AI badge says, by platform.
  aiTitle?: string;
  // Replaces the status badge's usual wording, such as "Sent to TikTok drafts".
  statusLabel?: string;
  // Where the post's clip was also posted, outside Localirs.
  elsewhere?: Array<{ id: string; url: string }>;
  // Extra lines under the caption, such as an error, and buttons on the right.
  details?: ReactNode;
  actions?: ReactNode;
};

// Posts as rows: publish time, account or channel, caption, status and the AI label, each linking to the post's page.
export function PostList({ posts }: { posts: PostListItem[] }) {
  return (
    <ul className={styles.list}>
      {posts.map((post) => (
        <li key={post.id} className={styles.row}>
          <div className={styles.main}>
            <Link href={`/posts/${post.id}`} className={styles.when}>
              <LocalTime date={post.scheduledAt} />
            </Link>
            <span className={styles.account}>{post.destination}</span>
            <StatusBadge status={post.status} label={post.statusLabel} />
            {post.aiGenerated ? <AiBadge title={post.aiTitle ?? "Posted with Instagram's AI info label"} /> : null}
            <p className={styles.caption}>{post.caption || "No caption"}</p>
            {post.elsewhere ? <PlatformChips links={post.elsewhere} /> : null}
            {post.details}
          </div>
          {post.actions ? <div className={styles.actions}>{post.actions}</div> : null}
        </li>
      ))}
    </ul>
  );
}
