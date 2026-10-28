import type { ReactNode } from "react";
import styles from "./alert.module.css";

// A message box. Errors are announced at once; info and success wait for the screen reader to finish.
export function Alert({ tone, children }: { tone: "info" | "success" | "error"; children: ReactNode }) {
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
