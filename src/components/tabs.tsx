"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import styles from "./tabs.module.css";

export type Tab = { id: string; label: string; content: ReactNode };

// Tabs over panels. Every panel stays mounted, so typed form values survive switching tabs. Arrow keys move between tabs.
// `initial` picks the tab shown first.
export function Tabs({ label, tabs, initial = tabs[0].id }: { label: string; tabs: Tab[]; initial?: string }) {
  const [active, setActive] = useState(initial);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const index = (tabs.findIndex((tab) => tab.id === active) + step + tabs.length) % tabs.length;
    setActive(tabs[index].id);
    buttons.current[index]!.focus();
  }

  return (
    <div className={styles.tabs}>
      <div role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(button) => {
              buttons.current[index] = button;
            }}
            type="button"
            role="tab"
            id={`${baseId}-${tab.id}-tab`}
            aria-controls={`${baseId}-${tab.id}-panel`}
            aria-selected={tab.id === active}
            tabIndex={tab.id === active ? 0 : -1}
            className={styles.tab}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-${tab.id}-panel`}
          aria-labelledby={`${baseId}-${tab.id}-tab`}
          hidden={tab.id !== active}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
