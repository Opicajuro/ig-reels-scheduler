"use client";

import { useState } from "react";
import type { ActionResult } from "@/lib/action-result";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/field";
import styles from "../clips.module.css";

export type PickedClip = { id: string; name: string };

// Downloads the picked clips as one ZIP, with a sheet giving each clip's post time, title and description.
// Times are read in this browser's timezone and the sheet shows them in that same timezone.
// The gap has the same 1 to 720 hours as scheduling on Instagram.
export function ExportForm({ projectId, clips }: { projectId: string; clips: PickedClip[] }) {
  const [firstAt, setFirstAt] = useState("");
  const [everyHours, setEveryHours] = useState(24);
  const ready = clips.length > 0 && firstAt !== "" && everyHours >= 1 && everyHours <= 720;

  // The export route answers a mistake in the request with a 4xx and its reason; anything else is a bug and throws.
  async function exportClips(): Promise<ActionResult> {
    const start = new Date(firstAt).getTime();
    const response = await fetch("/api/clips/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        clips: clips.map((clip, index) => ({
          clipId: clip.id,
          postAt: new Date(start + index * everyHours * 60 * 60 * 1000).toISOString(),
        })),
      }),
    });
    if (response.status >= 400 && response.status < 500) return { ok: false, error: await response.text() };
    if (!response.ok) throw new Error(await response.text());
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "posting.zip";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, message: "Downloaded" };
  }

  return (
    <ActionForm className={styles.panel} action={exportClips}>
      <p className={styles.muted}>
        A ZIP of the {clips.length} selected {clips.length === 1 ? "clip" : "clips"} and a sheet with each one&apos;s post
        time, title and description, to post by hand. Nothing is scheduled.
      </p>
      <Field label="First post at (your local time)">
        <input type="datetime-local" value={firstAt} onChange={(event) => setFirstAt(event.target.value)} required />
      </Field>
      <Field label="Hours between posts" hint="1 to 720">
        <input
          type="number"
          min={1}
          max={720}
          step={1}
          value={everyHours}
          onChange={(event) => setEveryHours(Number(event.target.value))}
          required
        />
      </Field>
      <SubmitButton variant="primary" disabled={!ready} pendingLabel="Building the ZIP…">
        Download ZIP
      </SubmitButton>
    </ActionForm>
  );
}
