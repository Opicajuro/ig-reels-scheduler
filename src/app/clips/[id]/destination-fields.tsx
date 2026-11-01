"use client";

import { Field } from "@/components/field";
import styles from "../clips.module.css";

export type AccountChoice = { id: string; username: string };
export type ChannelChoice = { id: string; title: string };
export type Destinations = { accountIds: string[]; ytAccountIds: string[] };

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...list, id] : list.filter((item) => item !== id);
}

// Where a clip goes: a box per Instagram account (accountId) and per YouTube channel (ytAccountId). With a channel
// ticked, the YouTube choices follow: privacy and whether it is made for kids, which YouTube requires.
export function DestinationFields({
  accounts,
  channels,
  value,
  onChange,
}: {
  accounts: AccountChoice[];
  channels: ChannelChoice[];
  value: Destinations;
  onChange: (value: Destinations) => void;
}) {
  if (accounts.length === 0 && channels.length === 0) {
    return <p className={styles.muted}>Connect an Instagram account or a YouTube channel on the Accounts page to schedule.</p>;
  }
  return (
    <fieldset className={styles.destinations}>
      <legend>Post to</legend>
      {accounts.map((account) => (
        <label key={account.id} className={styles.rights}>
          <input
            type="checkbox"
            name="accountId"
            value={account.id}
            checked={value.accountIds.includes(account.id)}
            onChange={(event) => onChange({ ...value, accountIds: toggle(value.accountIds, account.id, event.target.checked) })}
          />{" "}
          Instagram @{account.username}
        </label>
      ))}
      {channels.map((channel) => (
        <label key={channel.id} className={styles.rights}>
          <input
            type="checkbox"
            name="ytAccountId"
            value={channel.id}
            checked={value.ytAccountIds.includes(channel.id)}
            onChange={(event) =>
              onChange({ ...value, ytAccountIds: toggle(value.ytAccountIds, channel.id, event.target.checked) })
            }
          />{" "}
          YouTube Shorts: {channel.title}
        </label>
      ))}
    </fieldset>
  );
}

// The YouTube choices, shown once a channel is ticked. The description is the caption with #Shorts added.
export function YouTubeFields({ defaultTitle }: { defaultTitle?: string }) {
  return (
    <fieldset className={styles.destinations}>
      <legend>YouTube</legend>
      {defaultTitle !== undefined ? (
        <Field label="Title" hint="Up to 100 characters. The description is the caption, with #Shorts.">
          <input name="ytTitle" defaultValue={defaultTitle} maxLength={100} required />
        </Field>
      ) : (
        <p className={styles.muted}>Each Short is titled with its clip&apos;s title (or name), and described with its caption and #Shorts.</p>
      )}
      <Field label="Privacy">
        <select name="ytPrivacy" defaultValue="public">
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </select>
      </Field>
      <span className={styles.rights}>Made for kids (YouTube requires an answer):</span>
      <label className={styles.rights}>
        <input type="radio" name="ytMadeForKids" value="no" defaultChecked required /> No, it is not made for kids
      </label>
      <label className={styles.rights}>
        <input type="radio" name="ytMadeForKids" value="yes" /> Yes, it is made for kids
      </label>
    </fieldset>
  );
}
