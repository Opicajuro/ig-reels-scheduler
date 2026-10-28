"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AiEngineStatus } from "@/generated/prisma/enums";
import styles from "./ai.module.css";

const POLL_MS = 2000;

// While the engine installs, show the worker's step and how far it is. When it finishes, the page reloads once.
export function EngineProgress({ initialStep, initialPercent }: { initialStep: string | null; initialPercent: number | null }) {
  const router = useRouter();
  const [progress, setProgress] = useState({ step: initialStep, percent: initialPercent });

  useEffect(() => {
    const timer = setInterval(async () => {
      const response = await fetch("/api/ai/engine", { cache: "no-store" });
      if (!response.ok) throw new Error(`status check failed with ${response.status}`);
      const { status, step, percent } = (await response.json()) as { status: AiEngineStatus; step: string | null; percent: number | null };
      if (status === "installing") {
        setProgress({ step, percent });
        return;
      }
      clearInterval(timer);
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [router]);

  return (
    <div className={styles.progress} role="status">
      <span>{progress.step ?? "Waiting for the worker to start…"}</span>
      <progress max={100} value={progress.percent ?? 0} aria-label="Install progress" />
      <span className={styles.meta}>{progress.percent ?? 0}%</span>
    </div>
  );
}
