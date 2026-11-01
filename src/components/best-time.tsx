"use client";

import { useSyncExternalStore } from "react";
import { bestSlots, DEFAULT_GUIDELINE, MIN_POSTS_PER_SLOT, nextBestTime, slotLabel, toDateTimeLocal } from "@/lib/best-time";
import { Button } from "./button";
import styles from "./best-time.module.css";

/** a published post's views at its latest insight pull, with ISO times so it can come from a server component */
export type BestTimeSample = { accountId: string; at: string; views: number };

function subscribe() {
  return () => {};
}

// "Use best time" for a publish time input: fills in the next start of one of the account's three best weekday×hour
// slots, in the viewer's timezone. Until a slot has enough posts, it says so and gives a general guideline instead.
export function UseBestTime({
  samples,
  accountId,
  onPick,
}: {
  samples: BestTimeSample[];
  accountId: string;
  /** gets a datetime-local value */
  onPick: (value: string) => void;
}) {
  const inBrowser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const slots = bestSlots(
    samples.filter((sample) => sample.accountId === accountId).map((sample) => ({ at: new Date(sample.at), views: sample.views })),
    { utc: !inBrowser },
  );

  return (
    <div className={styles.bestTime}>
      <Button
        type="button"
        size="sm"
        disabled={!inBrowser || slots.length === 0}
        onClick={() => onPick(toDateTimeLocal(nextBestTime(slots, new Date(), false)))}
      >
        Use best time
      </Button>
      <span className={styles.hint}>
        {slots.length > 0
          ? `Your best slots by median views: ${slots.map(slotLabel).join(", ")}.`
          : `Not enough data yet: a slot needs ${MIN_POSTS_PER_SLOT} published posts with views. ${DEFAULT_GUIDELINE}`}
      </span>
    </div>
  );
}
