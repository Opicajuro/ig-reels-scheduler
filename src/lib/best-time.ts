// The best time to post, from the owner's own published posts: the weekday×hour slots with the highest median views.
// Like the Scheduled calendar, slots are in the viewer's timezone in the browser, or in UTC on the server. Weekdays
// start on Monday (0) and end on Sunday (6).

export type Slot = { weekday: number; hour: number };
export type BestSlot = Slot & { medianViews: number; posts: number };
export type ViewSample = { at: Date; views: number };

export const MIN_POSTS_PER_SLOT = 3;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A general guideline shown while the owner's own posts are too few to tell. It is not worked out from their data.
export const DEFAULT_GUIDELINE =
  "A common starting point is weekday evenings around 18:00 to 21:00 or lunchtime around 12:00 in your audience's timezone. Post at a few of these times and compare.";

export function slotOf(date: Date, utc: boolean): Slot {
  return utc
    ? { weekday: (date.getUTCDay() + 6) % 7, hour: date.getUTCHours() }
    : { weekday: (date.getDay() + 6) % 7, hour: date.getHours() };
}

export function slotLabel({ weekday, hour }: Slot): string {
  return `${WEEKDAYS[weekday]} ${String(hour).padStart(2, "0")}:00`;
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("the median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The slots with at least `minPosts` posts, highest median views first. A tie goes to the slot with more posts, then
// to the earlier one in the week.
export function bestSlots(
  samples: ViewSample[],
  { utc, minPosts = MIN_POSTS_PER_SLOT, limit = 3 }: { utc: boolean; minPosts?: number; limit?: number },
): BestSlot[] {
  const bySlot = new Map<number, number[]>();
  for (const sample of samples) {
    const { weekday, hour } = slotOf(sample.at, utc);
    const key = weekday * 24 + hour;
    bySlot.set(key, [...(bySlot.get(key) ?? []), sample.views]);
  }
  return [...bySlot.entries()]
    .filter(([, views]) => views.length >= minPosts)
    .map(([key, views]) => ({ weekday: Math.floor(key / 24), hour: key % 24, medianViews: median(views), posts: views.length }))
    .sort((a, b) => b.medianViews - a.medianViews || b.posts - a.posts || a.weekday * 24 + a.hour - (b.weekday * 24 + b.hour))
    .slice(0, limit);
}

// The first start of the slot after `now`. An hour skipped by a daylight saving change is skipped, so that day's slot
// is passed over for the next week's.
export function nextOccurrence(slot: Slot, now: Date, utc: boolean): Date {
  for (let day = 0; day <= 14; day += 1) {
    const candidate = utc
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day, slot.hour))
      : new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, slot.hour);
    const at = slotOf(candidate, utc);
    if (candidate.getTime() > now.getTime() && at.weekday === slot.weekday && at.hour === slot.hour) return candidate;
  }
  throw new Error(`no ${slotLabel(slot)} in the next two weeks`);
}

// The soonest future start of any of the slots.
export function nextBestTime(slots: Slot[], now: Date, utc: boolean): Date {
  if (slots.length === 0) throw new Error("no slots to pick a time from");
  return slots
    .map((slot) => nextOccurrence(slot, now, utc))
    .reduce((soonest, candidate) => (candidate.getTime() < soonest.getTime() ? candidate : soonest));
}

// The value of a datetime-local input showing the moment in the browser's timezone.
export function toDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
