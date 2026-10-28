"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AiVideoStatus } from "@/generated/prisma/enums";
import { StatusBadge } from "@/components/status-badge";
import styles from "./ai.module.css";

const POLL_MS = 2000;

// While a video is waiting or being made, show its status and the worker's step. When it finishes, the page reloads
// once to show the result.
export function VideoProgress({ jobId, initialStatus, initialStep }: { jobId: string; initialStatus: AiVideoStatus; initialStep: string | null }) {
  const router = useRouter();
  const [state, setState] = useState({ status: initialStatus, step: initialStep });

  useEffect(() => {
    const timer = setInterval(async () => {
      const response = await fetch(`/api/ai/videos/${jobId}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status check failed with ${response.status}`);
      const { status, step } = (await response.json()) as { status: AiVideoStatus; step: string | null };
      if (status === "queued" || status === "running") {
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
