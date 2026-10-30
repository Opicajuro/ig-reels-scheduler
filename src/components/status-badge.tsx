import type { AiEngineStatus, AiVideoStatus, ClipProjectStatus, PostStatus } from "@/generated/prisma/enums";
import styles from "./status-badge.module.css";

type Tone = "neutral" | "info" | "success" | "danger";

type Status = PostStatus | ClipProjectStatus | AiEngineStatus | AiVideoStatus;

const STATUSES: Record<Status, { label: string; tone: Tone }> = {
  scheduled: { label: "Scheduled", tone: "info" },
  container_created: { label: "Publishing", tone: "info" },
  published: { label: "Published", tone: "success" },
  canceled: { label: "Canceled", tone: "neutral" },
  awaiting_source: { label: "Waiting for upload", tone: "neutral" },
  ready: { label: "Ready", tone: "neutral" },
  rendering: { label: "Making clips", tone: "info" },
  done: { label: "Clips ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  not_installed: { label: "Not installed", tone: "neutral" },
  installing: { label: "Installing", tone: "info" },
  installed: { label: "Installed", tone: "success" },
  queued: { label: "Waiting", tone: "neutral" },
  running: { label: "Making video", tone: "info" },
};

export function statusLabel(status: Status): string {
  return STATUSES[status].label;
}

// The state of a post, a clip project, an AI video or the AI engine as a coloured pill. label replaces the usual
// wording.
export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const { label: usual, tone } = STATUSES[status];
  return <span className={`${styles.badge} ${styles[tone]}`}>{label ?? usual}</span>;
}
