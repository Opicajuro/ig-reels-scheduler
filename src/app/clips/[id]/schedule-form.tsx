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
}: {
  clipId: string;
  projectId: string;
  accounts: AccountChoice[];
  defaultCaption: string;
}) {
  const [when, setWhen] = useState("");
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
      <button type="submit" disabled={!scheduledAt}>
        Schedule on Instagram
      </button>
    </form>
  );
}
