"use client";

import { useState } from "react";
import { copyClipAction, deleteClipAction, renameClipAction, saveClipDetailsAction } from "../actions";
import { ConfirmForm } from "../confirm-form";
import { ExportForm } from "./export-form";
import { ScheduleForm } from "./schedule-form";
import { BulkScheduleForm } from "./bulk-schedule-form";
import styles from "../clips.module.css";

export type ClipView = {
  id: string;
  name: string;
  start: number;
  length: number;
  title: string | null;
  description: string | null;
  downloadUrl: string;
};

export type AccountView = { id: string; username: string };

function formatTime(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// Clips of one project, with picking for the upload sheet. Every change is a form posting to a server action.
export function ClipGrid({
  projectId,
  busy,
  clips,
  accounts,
  alreadyScheduledTo,
}: {
  projectId: string;
  busy: boolean;
  clips: ClipView[];
  accounts: AccountView[];
  alreadyScheduledTo: string[];
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());

  function togglePick(clipId: string, on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      if (on) {
        next.add(clipId);
      } else {
        next.delete(clipId);
      }
      return next;
    });
  }

  return (
    <>
      {clips.length === 0 ? (
        <p className={styles.muted}>No clips yet. Choose the settings and make clips.</p>
      ) : (
        <div className={styles.clips}>
          {clips.map((clip) => (
            <article key={clip.id} className={`${styles.clip} ${picked.has(clip.id) ? styles.selected : ""}`}>
              <video src={clip.downloadUrl} controls playsInline preload="metadata" />
              <div className={styles.clipBody}>
                <strong>{clip.name}</strong>
                <span className={styles.meta}>
                  {formatTime(clip.start)} – {formatTime(clip.start + clip.length)}
                </span>
              </div>
              <div className={styles.clipActions}>
                <label className={styles.pick}>
                  <input
                    type="checkbox"
                    checked={picked.has(clip.id)}
                    onChange={(event) => togglePick(clip.id, event.target.checked)}
                  />
                  Select
                </label>
                <form action={copyClipAction}>
                  <input type="hidden" name="clipId" value={clip.id} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <button type="submit" disabled={busy}>
                    Copy
                  </button>
                </form>
                <ConfirmForm
                  action={deleteClipAction}
                  message={`Delete ${clip.name}?`}
                  fields={{ clipId: clip.id, projectId }}
                  disabled={busy}
                >
                  Delete
                </ConfirmForm>
                <a href={clip.downloadUrl} download>
                  Download
                </a>
              </div>
              <details className={styles.details}>
                <summary>Posting and safe-clip rights</summary>
                <form action={saveClipDetailsAction}>
                  <input type="hidden" name="clipId" value={clip.id} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <label className={styles.label}>
                    Title (YouTube, up to 100 characters)
                    <input type="text" name="title" maxLength={100} defaultValue={clip.title ?? clip.name} />
                  </label>
                  <label className={styles.label}>
                    Description (with hashtags)
                    <textarea name="description" rows={4} maxLength={5000} defaultValue={clip.description ?? ""} />
                  </label>
                  <button type="submit">Save title and description</button>
                </form>
                <form action={renameClipAction}>
                  <input type="hidden" name="clipId" value={clip.id} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <label className={styles.label}>
                    Clip name
                    <input type="text" name="name" maxLength={60} defaultValue={clip.name} required />
                  </label>
                  <button type="submit">Rename</button>
                </form>
                <ScheduleForm
                  clipId={clip.id}
                  projectId={projectId}
                  accounts={accounts}
                  defaultCaption={clip.description || clip.title || clip.name}
                  alreadyScheduledTo={alreadyScheduledTo}
                />
              </details>
            </article>
          ))}
        </div>
      )}

      {picked.size > 0 ? (
        <BulkScheduleForm
          clips={clips.filter((clip) => picked.has(clip.id)).map((clip) => ({ id: clip.id, name: clip.name }))}
          accounts={accounts}
          alreadyScheduledTo={alreadyScheduledTo}
        />
      ) : null}

      <div className={styles.dock}>
        <div className={styles.dockInner}>
          <span className={styles.muted}>
            {picked.size} {picked.size === 1 ? "clip" : "clips"} selected
          </span>
          <ExportForm
            projectId={projectId}
            clips={clips.filter((clip) => picked.has(clip.id)).map((clip) => ({ id: clip.id, name: clip.name }))}
          />
        </div>
      </div>
    </>
  );
}
