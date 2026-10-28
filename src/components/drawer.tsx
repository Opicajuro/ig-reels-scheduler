"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "./button";
import styles from "./drawer.module.css";

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

// A side panel over the page. It is a non-modal dialog under its own backdrop, so toasts still show above it.
// It takes focus when it opens and gives it back when it closes, keeps Tab inside, and Escape or the backdrop closes it.
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current!.querySelector<HTMLElement>(FOCUSABLE)!.focus();
    return () => previous?.focus();
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    // Keys inside a dialog opened from this one, such as a ConfirmDialog, belong to that dialog.
    if ((event.target as Element).closest("dialog") !== panel.current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
    if (event.key === "Tab") {
      const items = [...panel.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (item) => !item.matches(":disabled") && item.checkVisibility(),
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  if (!open) return null;
  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <dialog ref={panel} open className={styles.drawer} aria-labelledby={titleId} aria-modal="true" onKeyDown={onKeyDown}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <Button type="button" size="sm" onClick={onClose}>
            Close
          </Button>
        </header>
        <div className={styles.body}>{children}</div>
      </dialog>
    </>
  );
}
