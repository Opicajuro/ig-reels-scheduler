"use client";

import { useState } from "react";
import { scheduleClipAction } from "../actions";
import styles from "../clips.module.css";

export type AccountChoice = { id: string; username: string };

// A datetime-local value has no timezone, so the browser turns it into an absolute time before it is sent.
// Without this, the server would read the time in its own timezone.
export function ScheduleForm({
  clipId,
  projectId,
  accounts,
  defaultCaption,
  alreadyScheduledTo,
}: {
  clipId: string;
  projectId: string;
  accounts: AccountChoice[];
  defaultCaption: string;
  /** accounts that already have a live post from this project, such as ["@foo"] */
  alreadyScheduledTo: string[];
}) {
  const [when, setWhen] = useState("");
  const [audioSource, setAudioSource] = useState("unknown");
  const scheduledAt = when ? new Date(when).toISOString() : "";

  return (
    <form action={scheduleClipAction}>
      <input type="hidden" name="clipId" value={clipId} />
      <input type="hidden" name="projectId" value={projectId} />
      <label className={styles.label}>
        Instagram account
        <select name="accountId" required>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              @{account.username}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.label}>
        Publish at (your local time)
        <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required />
      </label>
      <input type="hidden" name="scheduledAt" value={scheduledAt} />
      <label className={styles.label}>
        Caption
        <textarea name="caption" rows={3} maxLength={2200} defaultValue={defaultCaption} required />
      </label>
      <label className={styles.label}>
        Audio source
        <select name="audioSource" value={audioSource} onChange={(event) => setAudioSource(event.target.value)}>
          <option value="unknown">Unknown</option>
          <option value="original">Original (my voiceover or my own footage)</option>
          <option value="licensed">Licensed music or track</option>
          <option value="from_source">From the source video</option>
        </select>
      </label>
      {audioSource === "from_source" ? (
        <p className={styles.warning}>Audio from the source video can get the Reel claimed if you don&apos;t own that video.</p>
      ) : null}
      {alreadyScheduledTo.length > 0 ? (
        <p className={styles.warning}>
          Media from this project is already scheduled or published to {alreadyScheduledTo.join(", ")}. Instagram
          down-ranks duplicate content.
        </p>
      ) : null}
      <label className={styles.label}>
        <span>
          <input type="checkbox" name="rightsConfirmed" required /> I own or hold a license to this clip&apos;s video and
          audio
        </span>
      </label>
      <button type="submit" disabled={!scheduledAt}>
        Schedule on Instagram
      </button>
    </form>
  );
}
