"use client";

import { useState } from "react";
import { scheduleClipAction } from "../actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { UseBestTime, type BestTimeSample } from "@/components/best-time";
import { Field } from "@/components/field";
import styles from "../clips.module.css";
import { DestinationFields, YouTubeFields, type AccountChoice, type ChannelChoice, type Destinations } from "./destination-fields";

export type { AccountChoice, ChannelChoice } from "./destination-fields";

// A datetime-local value has no timezone, so the browser turns it into an absolute time before it is sent.
// Without this, the server would read the time in its own timezone.
export function ScheduleForm({
  clipId,
  projectId,
  accounts,
  channels,
  defaultCaption,
  defaultTitle,
  clipAiGenerated,
  alreadyScheduledTo,
  bestTimeSamples,
}: {
  clipId: string;
  projectId: string;
  accounts: AccountChoice[];
  channels: ChannelChoice[];
  defaultCaption: string;
  /** the YouTube title to start from: the clip's title, or its name */
  defaultTitle: string;
  /** a clip made with AI always carries Instagram's AI info label and YouTube's disclosure, so its box is ticked and locked */
  clipAiGenerated: boolean;
  /** accounts that already have a live post from this project, such as ["@foo"] */
  alreadyScheduledTo: string[];
  bestTimeSamples: BestTimeSample[];
}) {
  const [destinations, setDestinations] = useState<Destinations>({
    accountIds: accounts.slice(0, 1).map((account) => account.id),
    ytAccountIds: [],
  });
  const [when, setWhen] = useState("");
  const [audioSource, setAudioSource] = useState("unknown");
  const scheduledAt = when ? new Date(when).toISOString() : "";
  const instagram = destinations.accountIds.length > 0;
  const youtube = destinations.ytAccountIds.length > 0;

  return (
    <ActionForm action={scheduleClipAction} className={styles.panel}>
      <input type="hidden" name="clipId" value={clipId} />
      <input type="hidden" name="projectId" value={projectId} />
      <DestinationFields accounts={accounts} channels={channels} value={destinations} onChange={setDestinations} />
      <Field label="Publish at (your local time)">
        <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required />
      </Field>
      {instagram ? <UseBestTime samples={bestTimeSamples} accountId={destinations.accountIds[0]} onPick={setWhen} /> : null}
      <input type="hidden" name="scheduledAt" value={scheduledAt} />
      <Field label="Caption" hint={youtube ? "Also the YouTube description, with #Shorts added." : undefined}>
        <textarea name="caption" rows={3} maxLength={2200} defaultValue={defaultCaption} required />
      </Field>
      {youtube ? <YouTubeFields defaultTitle={defaultTitle} /> : null}
      <Field label="Audio source">
        <select name="audioSource" value={audioSource} onChange={(event) => setAudioSource(event.target.value)}>
          <option value="unknown">Unknown</option>
          <option value="original">Original (my voiceover or my own footage)</option>
          <option value="licensed">Licensed music or track</option>
          <option value="from_source">From the source video</option>
        </select>
      </Field>
      {audioSource === "from_source" ? (
        <p className={styles.warning}>Audio from the source video can get the post claimed if you don&apos;t own that video.</p>
      ) : null}
      {instagram && alreadyScheduledTo.length > 0 ? (
        <p className={styles.warning}>
          Media from this project is already scheduled or published to {alreadyScheduledTo.join(", ")}. Instagram
          down-ranks duplicate content.
        </p>
      ) : null}
      <label className={styles.rights}>
        <input type="checkbox" name="aiGenerated" defaultChecked={clipAiGenerated} disabled={clipAiGenerated} /> This video is
        AI-generated (Instagram shows an AI info label; YouTube is told it has altered or synthetic content)
      </label>
      <label className={styles.rights}>
        <input type="checkbox" name="rightsConfirmed" required /> I own or hold a license to this clip&apos;s video and audio
      </label>
      <SubmitButton disabled={!scheduledAt || (!instagram && !youtube)} pendingLabel="Scheduling…">
        Schedule
      </SubmitButton>
    </ActionForm>
  );
}
