import type { ClipProjectStatus, PostStatus } from "@/generated/prisma/enums";
import styles from "./status-badge.module.css";

type Tone = "neutral" | "info" | "success" | "danger";

const STATUSES: Record<PostStatus | ClipProjectStatus, { label: string; tone: Tone }> = {
  scheduled: { label: "Scheduled", tone: "info" },
  container_created: { label: "Publishing", tone: "info" },
  published: { label: "Published", tone: "success" },
  canceled: { label: "Canceled", tone: "neutral" },
  awaiting_source: { label: "Waiting for upload", tone: "neutral" },
  ready: { label: "Ready", tone: "neutral" },
  rendering: { label: "Making clips", tone: "info" },
  done: { label: "Clips ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

// The state of a post or a clip project as a coloured pill.
export function StatusBadge({ status }: { status: PostStatus | ClipProjectStatus }) {
  const { label, tone } = STATUSES[status];
  return <span className={`${styles.badge} ${styles[tone]}`}>{label}</span>;
}
