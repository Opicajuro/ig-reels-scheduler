"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "./button";
import styles from "./confirm-dialog.module.css";

// Asks before something that cannot be undone. A native modal dialog: it traps focus, Escape cancels, and the safe
// button has focus when it opens.
export function ConfirmDialog({
  open,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const messageId = useId();

  useEffect(() => {
    const element = dialog.current!;
    if (open && !element.open) {
      element.showModal();
      cancel.current!.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className={styles.dialog} aria-describedby={messageId} onClose={onCancel}>
      <p id={messageId}>{message}</p>
      <div className={styles.buttons}>
        <Button ref={cancel} type="button" onClick={onCancel}>
          Go back
        </Button>
        <Button type="button" variant="danger" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
