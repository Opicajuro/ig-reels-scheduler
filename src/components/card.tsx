import type { ReactNode } from "react";
import styles from "./card.module.css";

// A raised panel that groups related content.
export function Card({ children }: { children: ReactNode }) {
  return <div className={styles.card}>{children}</div>;
}
