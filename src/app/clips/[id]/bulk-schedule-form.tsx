"use client";

import { useState } from "react";
import { bulkScheduleClipsAction } from "../actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { UseBestTime, type BestTimeSample } from "@/components/best-time";
import { AiBadge } from "@/components/ai-badge";
import { Field } from "@/components/field";
import { LocalTime } from "@/components/local-time";
import styles from "../clips.module.css";
import {
  anyDestination,
  DestinationFields,
  NO_DESTINATIONS,
  OtherPlatformNotes,
  YouTubeFields,
  type AccountChoice,
  type ChannelChoice,
  type Destinations,
} from "./destination-fields";

export type SelectedClip = { id: string; name: string; caption: string; youTubeTitle: string; aiGenerated: boolean };

// Schedules every selected clip to the ticked accounts and channels, spaced by a gap, under one rights confirmation.
// Before sending, it lists each clip with the caption (and YouTube title) it is posted with and its publish time, worked
// out the same way as on the server. Clips made with AI always carry the AI label; the AI box adds it to the others.
// A datetime-local value has no timezone, so the browser turns it into an absolute time before it is sent.
export function BulkScheduleForm({
  projectId,
  clips,
  accounts,
  channels,
  alreadyScheduledTo,
  bestTimeSamples,
}: {
  projectId: string;
  clips: SelectedClip[];
  accounts: AccountChoice[];
  channels: ChannelChoice[];
  /** accounts that already have a live post from this project, such as ["@foo"] */
  alreadyScheduledTo: string[];
  bestTimeSamples: BestTimeSample[];
}) {
  const [destinations, setDestinations] = useState<Destinations>({
    accountIds: accounts.slice(0, 1).map((account) => account.id),
    ...NO_DESTINATIONS,
  });
  const instagram = destinations.accountIds.length > 0;
  const youtube = destinations.ytAccountIds.length > 0;
  const facebook = destinations.fbPageIds.length > 0;
  const tiktok = destinations.ttAccountIds.length > 0;
  const [when, setWhen] = useState("");
  const [gapHours, setGapHours] = useState("24");
  const [audioSource, setAudioSource] = useState("unknown");
  const [aiGenerated, setAiGenerated] = useState(false);
  const scheduledAt = when ? new Date(when).toISOString() : "";
  const gap = Number(gapHours);
  const gapValid = Number.isInteger(gap) && gap >= 1 && gap <= 720;
  const firstTime = scheduledAt ? new Date(scheduledAt).getTime() : 0;

  return (
    <ActionForm action={bulkScheduleClipsAction} className={styles.panel}>
      <input type="hidden" name="projectId" value={projectId} />
      {clips.map((clip) => (
        <input key={clip.id} type="hidden" name="clipId" value={clip.id} />
      ))}
      <input type="hidden" name="scheduledAt" value={scheduledAt} />
      <DestinationFields accounts={accounts} channels={channels} value={destinations} onChange={setDestinations} />
      <Field label="First publish time (your local time)">
        <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} required />
      </Field>
      {instagram ? <UseBestTime samples={bestTimeSamples} accountId={destinations.accountIds[0]} onPick={setWhen} /> : null}
      <Field label="Hours between posts" hint="1 to 720">
        <input
          type="number"
          name="gapHours"
          min={1}
          max={720}
          step={1}
          value={gapHours}
          onChange={(event) => setGapHours(event.target.value)}
          required
        />
      </Field>
      <ol className={styles.preview} aria-label="What will be posted">
        {clips.map((clip, index) => (
          <li key={clip.id}>
            <div className={styles.previewHead}>
              <strong>
                {clip.name}
                {clip.aiGenerated || aiGenerated ? (
                  <>
                    {" "}
                    <AiBadge title="Posted with Instagram's AI info label" />
                  </>
                ) : null}
              </strong>
              <span className={styles.meta}>
                {scheduledAt && gapValid ? (
                  <LocalTime date={new Date(firstTime + index * gap * 60 * 60 * 1000)} />
                ) : (
                  "Set the time and gap"
                )}
              </span>
            </div>
            {youtube ? <p className={styles.caption}>YouTube: {clip.youTubeTitle}</p> : null}
            <p className={styles.caption}>{clip.caption}</p>
            {youtube && [...clip.youTubeTitle].length > 100 ? (
              <p className={styles.warning}>This title is over YouTube&apos;s 100 characters. Shorten the clip&apos;s title first.</p>
            ) : null}
            {instagram && clip.caption.length > 2200 ? (
              <p className={styles.warning}>This caption is over 2,200 characters. Shorten the description first.</p>
            ) : null}
          </li>
        ))}
      </ol>
      {youtube ? <YouTubeFields /> : null}
      <OtherPlatformNotes facebook={facebook} tiktok={tiktok} />
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
        <input
          type="checkbox"
          name="aiGenerated"
          checked={aiGenerated}
          onChange={(event) => setAiGenerated(event.target.checked)}
        />{" "}
        These videos are AI-generated (Instagram shows an AI info label; YouTube is told they have altered or synthetic
        content; Facebook is told they were made with AI; on TikTok, turn on the AI-generated label when you post the drafts)
        {clips.some((clip) => clip.aiGenerated) ? ". Clips made with AI always carry it." : null}
      </label>
      <label className={styles.rights}>
        <input type="checkbox" name="rightsConfirmed" required /> I own or hold a license to these clips&apos; video and audio
      </label>
      <SubmitButton variant="primary" disabled={!scheduledAt || !anyDestination(destinations)} pendingLabel="Scheduling…">
        Schedule {clips.length} {clips.length === 1 ? "clip" : "clips"}
      </SubmitButton>
    </ActionForm>
  );
}
