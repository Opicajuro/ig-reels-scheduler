"use client";

import { useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import styles from "../clips.module.css";

export type PickedClip = { id: string; name: string };

// Downloads the picked clips as one ZIP, with a sheet giving each clip's post time, title and description.
// Times are read in this browser's timezone and the sheet shows them in that same timezone.
export function ExportForm({ projectId, clips }: { projectId: string; clips: PickedClip[] }) {
  const [firstAt, setFirstAt] = useState("");
  const [everyHours, setEveryHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const ready = clips.length > 0 && firstAt !== "" && everyHours >= 1 && !busy;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("Building the ZIP…");
    try {
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
      if (!response.ok) throw new Error(await response.text());
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "posting.zip";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Downloaded.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "the ZIP could not be built");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.exportForm} onSubmit={handleSubmit}>
      <Field label="First post at (your time)">
        <input type="datetime-local" value={firstAt} onChange={(event) => setFirstAt(event.target.value)} required />
      </Field>
      <Field label="Then every (hours)">
        <input
          type="number"
          min={1}
          max={168}
          value={everyHours}
          onChange={(event) => setEveryHours(Number(event.target.value))}
          required
        />
      </Field>
      <Button type="submit" variant="primary" disabled={!ready}>
        Download for posting
      </Button>
      {status ? <span className={styles.muted}>{status}</span> : null}
    </form>
  );
}
