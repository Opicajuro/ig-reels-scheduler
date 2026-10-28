"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ClipProjectStatus } from "@/generated/prisma/enums";
import { StatusBadge } from "@/components/status-badge";
import styles from "./clips.module.css";

const POLL_MS = 2000;

// While clips are being made, show what the worker is doing. Only when it finishes is the page reloaded, once,
// so the clip previews are not re-signed and restarted on every poll.
export function RenderProgress({ projectId, initialStep }: { projectId: string; initialStep: string | null }) {
  const router = useRouter();
  const [step, setStep] = useState(initialStep);

  useEffect(() => {
    const timer = setInterval(async () => {
      const response = await fetch(`/api/clips/${projectId}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status check failed with ${response.status}`);
      const { status, renderStep } = (await response.json()) as { status: ClipProjectStatus; renderStep: string | null };
      if (status === "rendering") {
        setStep(renderStep);
        return;
      }
      clearInterval(timer);
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, router]);

  return (
    <p className={styles.progress} role="status">
      <StatusBadge status="rendering" />
      <span>{step ?? "Waiting for the worker to start…"}</span>
    </p>
  );
}
