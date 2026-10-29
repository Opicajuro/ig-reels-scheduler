import styles from "./ai-badge.module.css";

// The "AI" pill on a clip made with AI and on a post that carries Instagram's AI info label.
export function AiBadge({ title }: { title: string }) {
  return (
    <span className={styles.badge} title={title}>
      AI
    </span>
  );
}
