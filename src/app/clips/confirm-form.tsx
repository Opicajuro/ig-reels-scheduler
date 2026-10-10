"use client";

import type { ReactNode } from "react";
import styles from "./clips.module.css";

// A form whose button asks for confirmation first. Used for deletes.
export function ConfirmForm({
  action,
  message,
  fields,
  disabled,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  message: string;
  fields: Record<string, string>;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className={styles.danger} disabled={disabled}>
        {children}
      </button>
    </form>
  );
}
