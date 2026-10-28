import Link from "next/link";
import type { ReactNode } from "react";
import type { PostStatus } from "@/generated/prisma/enums";
import { LocalTime } from "./local-time";
import { StatusBadge } from "./status-badge";
import styles from "./post-list.module.css";

export type PostListItem = {
  id: string;
  scheduledAt: Date;
  status: PostStatus;
  caption: string;
  account: { username: string };
  // Extra lines under the caption, such as an error, and buttons on the right.
  details?: ReactNode;
  actions?: ReactNode;
};

// Posts as rows: publish time, account, caption and status, each linking to the post's page.
export function PostList({ posts }: { posts: PostListItem[] }) {
  return (
    <ul className={styles.list}>
      {posts.map((post) => (
        <li key={post.id} className={styles.row}>
          <div className={styles.main}>
            <Link href={`/posts/${post.id}`} className={styles.when}>
              <LocalTime date={post.scheduledAt} />
            </Link>
            <span className={styles.account}>@{post.account.username}</span>
            <StatusBadge status={post.status} />
            <p className={styles.caption}>{post.caption || "No caption"}</p>
            {post.details}
          </div>
          {post.actions ? <div className={styles.actions}>{post.actions}</div> : null}
        </li>
      ))}
    </ul>
  );
}
