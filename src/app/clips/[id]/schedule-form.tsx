"use client";

import { useState } from "react";
import { scheduleClipAction } from "../actions";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
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
      {accounts.length === 0 ? (
        <p className={styles.muted}>Connect an Instagram account to schedule this clip. You can confirm the rights below now.</p>
      ) : null}
      <Field label="Instagram account">
        <select name="accountId" required disabled={accounts.length === 0}>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              @{account.username}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Publish at (your local time)">
        <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required />
      </Field>
      <input type="hidden" name="scheduledAt" value={scheduledAt} />
      <Field label="Caption">
        <textarea name="caption" rows={3} maxLength={2200} defaultValue={defaultCaption} required />
      </Field>
      <Field label="Audio source">
        <select name="audioSource" value={audioSource} onChange={(event) => setAudioSource(event.target.value)}>
          <option value="unknown">Unknown</option>
          <option value="original">Original (my voiceover or my own footage)</option>
          <option value="licensed">Licensed music or track</option>
          <option value="from_source">From the source video</option>
        </select>
      </Field>
      {audioSource === "from_source" ? (
        <p className={styles.warning}>Audio from the source video can get the Reel claimed if you don&apos;t own that video.</p>
      ) : null}
      {alreadyScheduledTo.length > 0 ? (
        <p className={styles.warning}>
          Media from this project is already scheduled or published to {alreadyScheduledTo.join(", ")}. Instagram
          down-ranks duplicate content.
        </p>
      ) : null}
      <label className={styles.rights}>
        <input type="checkbox" name="rightsConfirmed" required /> I own or hold a license to this clip&apos;s video and audio
      </label>
      <Button type="submit" disabled={!scheduledAt || accounts.length === 0}>
        Schedule on Instagram
      </Button>
    </form>
  );
}
