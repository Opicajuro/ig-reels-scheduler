"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { SlideshowStatus } from "@/generated/prisma/enums";
import { StatusBadge } from "@/components/status-badge";
import styles from "./ai.module.css";

const POLL_MS = 2000;

// While a slideshow's script is written or it is made, show its status and the worker's step. When that ends, the page
// reloads once to show the draft or the result.
export function SlideshowProgress({
  jobId,
  initialStatus,
  initialStep,
}: {
  jobId: string;
  initialStatus: SlideshowStatus;
  initialStep: string | null;
}) {
  const router = useRouter();
  const [state, setState] = useState({ status: initialStatus, step: initialStep });

  useEffect(() => {
    const timer = setInterval(async () => {
      const response = await fetch(`/api/slideshows/${jobId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status check failed with ${response.status}`);
      const { status, step } = (await response.json()) as { status: SlideshowStatus; step: string | null };
      if (status === "writing" || status === "queued" || status === "running") {
        setState({ status, step });
        return;
      }
      clearInterval(timer);
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [jobId, router]);

  return (
    <span className={styles.jobState} role="status">
      <StatusBadge status={state.status} />
      <span className={styles.meta}>{state.step ?? (state.status === "queued" ? "Waiting for the worker" : "")}</span>
    </span>
  );
}
