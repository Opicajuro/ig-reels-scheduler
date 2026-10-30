"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import styles from "./toast.module.css";

const SHOW_MS = 4000;

const ToastContext = createContext<((message: string) => void) | null>(null);

let nextId = 0;

// The one place short success messages appear, such as "Saved". It sits in the root layout, so a message stays up
// while the page changes.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; message: string }>>([]);

  const show = useCallback((message: string) => {
    const id = nextId++;
    setToasts((current) => [...current, { id, message }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), SHOW_MS);
  }, []);

  return (
    <ToastContext value={show}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {toasts.map((toast) => (
          <p key={toast.id} className={styles.toast}>
            <svg className={styles.check} viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.15" />
              <path d="M6 12.5l4 4 8-9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {toast.message}
          </p>
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast(): (message: string) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast needs a ToastProvider above it");
  return show;
}
