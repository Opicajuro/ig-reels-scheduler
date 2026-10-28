"use client";

import { useState } from "react";
import { bulkScheduleClipsAction } from "../actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { LocalTime } from "@/components/local-time";
import styles from "../clips.module.css";
import type { AccountChoice } from "./schedule-form";

export type SelectedClip = { id: string; name: string };

// Schedules every selected clip to one account, spaced by a gap, under one rights confirmation.
// A datetime-local value has no timezone, so the browser turns it into an absolute time before it is sent.
export function BulkScheduleForm({
  projectId,
  clips,
  accounts,
  alreadyScheduledTo,
}: {
  projectId: string;
  clips: SelectedClip[];
  accounts: AccountChoice[];
  /** accounts that already have a live post from this project, such as ["@foo"] */
  alreadyScheduledTo: string[];
}) {
  const [when, setWhen] = useState("");
  const [gapHours, setGapHours] = useState("24");
  const [audioSource, setAudioSource] = useState("unknown");
  const scheduledAt = when ? new Date(when).toISOString() : "";
  const gap = Number(gapHours);
  const firstTime = scheduledAt ? new Date(scheduledAt).getTime() : 0;
  const times = scheduledAt && Number.isFinite(gap) ? clips.map((_, index) => new Date(firstTime + index * gap * 60 * 60 * 1000)) : [];

  return (
    <Card>
      <ActionForm action={bulkScheduleClipsAction} className={styles.panel}>
        <h2>Schedule the selected clips</h2>
        <input type="hidden" name="projectId" value={projectId} />
        {clips.map((clip) => (
          <input key={clip.id} type="hidden" name="clipId" value={clip.id} />
        ))}
        <input type="hidden" name="scheduledAt" value={scheduledAt} />
        <Field label="Instagram account">
          <select name="accountId" required disabled={accounts.length === 0}>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                @{account.username}
              </option>
            ))}
          </select>
        </Field>
        {accounts.length === 0 ? (
          <p className={styles.muted}>Connect an Instagram account to schedule these clips. You can confirm the rights below now.</p>
        ) : null}
        <Field label="First publish time (your local time)">
          <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required />
        </Field>
        <Field label="Hours between posts">
          <input
            type="number"
            name="gapHours"
            min={1}
            max={720}
            value={gapHours}
            onChange={(event) => setGapHours(event.target.value)}
            required
          />
        </Field>
        {times.length > 0 ? (
          <ol className={styles.muted}>
            {clips.map((clip, index) => (
              <li key={clip.id}>
                {clip.name}: <LocalTime date={times[index]} />
              </li>
            ))}
          </ol>
        ) : null}
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
          <input type="checkbox" name="rightsConfirmed" required /> I own or hold a license to these clips&apos; video and audio
        </label>
        <SubmitButton disabled={!scheduledAt || accounts.length === 0} pendingLabel="Scheduling…">
          Schedule {clips.length} {clips.length === 1 ? "clip" : "clips"} on Instagram
        </SubmitButton>
      </ActionForm>
    </Card>
  );
}
