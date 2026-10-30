"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ClipProjectStatus } from "@/generated/prisma/enums";
import { StatusBadge } from "@/components/status-badge";
import styles from "./clips.module.css";

const POLL_MS = 2000;

// 75 seconds → "1:15", an hour and more → "1:02:05".
function formatElapsed(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// While clips are being made, show what the worker is doing and for how long. The page is reloaded once each time
// another clip is finished, so it shows up straight away, and once more at the end; not on every poll, so the clip
// previews are not re-signed and restarted all the time. A render that the worker goes on with after the PC slept or
// Localirs was closed says "Resuming… clip N of M", and its time still counts from when "Make clips" was pressed.
export function RenderProgress({
  projectId,
  initialStep,
  startedAt,
  initialClipsDone,
}: {
  projectId: string;
  initialStep: string | null;
  startedAt: string;
  initialClipsDone: number;
}) {
  const router = useRouter();
  const [step, setStep] = useState(initialStep);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let clipsDone = initialClipsDone;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/clips/${projectId}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(`status check failed with ${response.status}`);
      const state = (await response.json()) as { status: ClipProjectStatus; renderStep: string | null; clipsDone: number };
      if (state.status !== "rendering") {
        clearInterval(timer);
        router.refresh();
        return;
      }
      setStep(state.renderStep);
      if (state.clipsDone > clipsDone) {
        clipsDone = state.clipsDone;
        router.refresh();
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [projectId, initialClipsDone, router]);

  const elapsed = formatElapsed(Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)));
  return (
    <p className={styles.progress} role="status">
      <StatusBadge status="rendering" />
      <span>{step ?? "Waiting for the worker to start…"}</span>
      <span className={styles.elapsed} aria-label={`running for ${elapsed}`}>
        {elapsed}
      </span>
    </p>
  );
}
