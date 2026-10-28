import type { ReactNode } from "react";
import styles from "./empty-state.module.css";

// What a list shows when it has nothing in it.
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}
