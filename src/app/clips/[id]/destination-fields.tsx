"use client";

import { Field } from "@/components/field";
import styles from "../clips.module.css";

export type AccountChoice = { id: string; username: string };
// A YouTube channel, a Facebook Page or a TikTok account.
export type ChannelChoice = { id: string; title: string; platform: "youtube" | "facebook" | "tiktok" };
export type Destinations = { accountIds: string[]; ytAccountIds: string[]; fbPageIds: string[]; ttAccountIds: string[] };

export const NO_DESTINATIONS: Omit<Destinations, "accountIds"> = { ytAccountIds: [], fbPageIds: [], ttAccountIds: [] };

export function anyDestination(value: Destinations): boolean {
  return value.accountIds.length + value.ytAccountIds.length + value.fbPageIds.length + value.ttAccountIds.length > 0;
}

// Each kind of channel: its form field, its list in Destinations and its label.
const CHANNEL_KINDS = {
  youtube: { name: "ytAccountId", list: "ytAccountIds", label: "YouTube Shorts" },
  facebook: { name: "fbPageId", list: "fbPageIds", label: "Facebook Page" },
  tiktok: { name: "ttAccountId", list: "ttAccountIds", label: "TikTok (draft)" },
} as const;

function toggle(list: string[], id: string, on: boolean): string[] {
  return on ? [...list, id] : list.filter((item) => item !== id);
}

// Where a clip goes: a box per Instagram account (accountId), YouTube channel (ytAccountId), Facebook Page (fbPageId) and
// TikTok account (ttAccountId). With a YouTube channel ticked, the YouTube choices follow: privacy and whether it is
// made for kids, which YouTube requires.
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
    return (
      <p className={styles.muted}>
        Connect an Instagram account, a YouTube channel, a Facebook Page or a TikTok account on the Accounts page to schedule.
      </p>
    );
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
      {channels.map((channel) => {
        const kind = CHANNEL_KINDS[channel.platform];
        return (
          <label key={channel.id} className={styles.rights}>
            <input
              type="checkbox"
              name={kind.name}
              value={channel.id}
              checked={value[kind.list].includes(channel.id)}
              onChange={(event) => onChange({ ...value, [kind.list]: toggle(value[kind.list], channel.id, event.target.checked) })}
            />{" "}
            {kind.label}: {channel.title}
          </label>
        );
      })}
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

// What happens on Facebook and TikTok, shown once one of them is ticked.
export function OtherPlatformNotes({ facebook, tiktok }: { facebook: boolean; tiktok: boolean }) {
  if (!facebook && !tiktok) return null;
  return (
    <ul className={styles.muted}>
      {facebook ? <li>Facebook: published as a Reel on the Page at the publish time, described with the caption. A Reel is 3 to 90 seconds.</li> : null}
      {tiktok ? (
        <li>
          TikTok: sent to the account&apos;s inbox as a draft at the publish time. TikTok notifies you in the app, where you add
          the caption and post it.
        </li>
      ) : null}
    </ul>
  );
}
