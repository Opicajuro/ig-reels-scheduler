"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { markSourceUploadedAction } from "./actions";
import styles from "./clips.module.css";

export function UploadForm() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setStatus("Choose a video first.");
      return;
    }
    const dot = file.name.lastIndexOf(".");
    const extension = dot > 0 ? file.name.slice(dot) : "";
    const name = dot > 0 ? file.name.slice(0, dot) : file.name;

    setBusy(true);
    setStatus("Starting the upload…");
    try {
      const started = await fetch("/api/clips/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, extension }),
      });
      if (!started.ok) throw new Error(await started.text());
      const { projectId, uploadUrl, contentType } = (await started.json()) as {
        projectId: string;
        uploadUrl: string;
        contentType: string;
      };

      setStatus("Uploading…");
      const sent = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
      if (!sent.ok) throw new Error(`upload failed with status ${sent.status}`);

      const formData = new FormData();
      formData.set("projectId", projectId);
      await markSourceUploadedAction(formData);
      router.push(`/clips/${projectId}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "upload failed");
      setBusy(false);
    }
  }

  return (
    <Card>
      <form className={styles.panel} onSubmit={handleSubmit}>
        <h2>Upload a video</h2>
        <p className={styles.muted}>Pick a file from this computer. It goes straight to storage.</p>
        <input ref={input} type="file" accept="video/*" />
        <Button type="submit" variant="primary" disabled={busy}>
          Upload video
        </Button>
        <p className={styles.notice}>{status}</p>
      </form>
    </Card>
  );
}
