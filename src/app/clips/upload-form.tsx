"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { markSourceUploadedAction } from "./actions";
import styles from "./clips.module.css";

// Sends the file with XMLHttpRequest, because fetch cannot report upload progress.
function putFile(url: string, file: File, contentType: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("Content-Type", contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.floor((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      // Storage answers an error with S3's XML, whose Message says what went wrong.
      else reject(new Error(request.responseXML?.querySelector("Message")?.textContent ?? `upload failed with status ${request.status}`));
    };
    request.onerror = () => reject(new Error("upload failed: the storage could not be reached"));
    request.send(file);
  });
}

export function UploadForm() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setError("Choose a video first.");
      return;
    }
    const dot = file.name.lastIndexOf(".");
    const extension = dot > 0 ? file.name.slice(dot) : "";
    const name = dot > 0 ? file.name.slice(0, dot) : file.name;

    setBusy(true);
    setError("");
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

      setStatus("Uploading… 0%");
      await putFile(uploadUrl, file, contentType, (percent) => setStatus(`Uploading… ${percent}%`));
      setStatus("Finishing…");

      const formData = new FormData();
      formData.set("projectId", projectId);
      await markSourceUploadedAction(formData);
      router.push(`/clips/${projectId}`);
    } catch (err) {
      setStatus("");
      setError(err instanceof Error ? err.message : "upload failed");
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
        {error ? <Alert tone="error">{error}</Alert> : <p className={styles.notice}>{status}</p>}
      </form>
    </Card>
  );
}
