import type { ComponentProps } from "react";
import styles from "./button.module.css";

type Look = {
  variant?: "primary" | "secondary" | "danger";
  size?: "md" | "sm";
};

function lookClass({ variant = "secondary", size = "md" }: Look): string {
  return `${styles.button} ${styles[variant]} ${styles[size]}`;
}

export function Button({ variant, size, ...props }: Look & Omit<ComponentProps<"button">, "className">) {
  return <button {...props} className={lookClass({ variant, size })} />;
}

// A link that looks like a button. A plain <a>, because its targets are API routes and file downloads, not pages.
export function ButtonLink({ variant, size, ...props }: Look & Omit<ComponentProps<"a">, "className">) {
  return <a {...props} className={lookClass({ variant, size })} />;
}
