"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/button";

// A form whose button asks for confirmation first. Used for deletes.
export function ConfirmForm({
  action,
  message,
  fields,
  disabled,
  size,
  children,
}: {
  action: (formData: FormData) => Promise<void>;
  message: string;
  fields: Record<string, string>;
  disabled?: boolean;
  size?: "md" | "sm";
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
      <Button type="submit" variant="danger" size={size} disabled={disabled}>
        {children}
      </Button>
    </form>
  );
}
