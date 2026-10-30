"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "./menu.module.css";

export type MenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { label: string; href: string; download: true };

// A ⋯ button that opens a list of actions. Arrow keys, Home and End move through them; Escape, Tab or a click outside
// closes it.
export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    root.current!.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")!.focus();
    function onPointerDown(event: PointerEvent) {
      if (!root.current!.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Focus goes back to the button before the menu closes, so a drawer the item opens returns focus there.
  function close() {
    button.current!.focus();
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    // Tab then moves on from the button, as it would from any other control.
    if (event.key === "Tab") {
      close();
      return;
    }
    const entries = [...root.current!.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)")];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? (index + 1) % entries.length
        : event.key === "ArrowUp"
          ? (index - 1 + entries.length) % entries.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? entries.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    entries[next].focus();
  }

  return (
    <div ref={root} className={styles.root}>
      <button
        ref={button}
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        ⋯
      </button>
      {open ? (
        <div id={listId} role="menu" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
          {items.map((item) =>
            "href" in item ? (
              <a key={item.label} role="menuitem" tabIndex={-1} href={item.href} download className={styles.item} onClick={close}>
                {item.label}
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={item.disabled}
                className={`${styles.item} ${item.danger ? styles.danger : ""}`}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
