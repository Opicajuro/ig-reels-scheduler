import { describe, expect, it } from "vitest";
import { bestSlots, median, nextBestTime, nextOccurrence, slotLabel, slotOf, toDateTimeLocal } from "./best-time";

// 2026-10-26 is a Monday.
const at = (iso: string) => new Date(`${iso}Z`);

describe("slotOf", () => {
  it("gives a Monday-first weekday and the hour", () => {
    expect(slotOf(at("2026-10-26T18:30:00"), true)).toEqual({ weekday: 0, hour: 18 });
    expect(slotOf(at("2026-11-01T00:05:00"), true)).toEqual({ weekday: 6, hour: 0 });
  });
});

describe("median", () => {
  it("takes the middle value, or the mean of the two middle ones", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 10])).toBe(3.5);
  });

  it("refuses no values", () => {
    expect(() => median([])).toThrow();
  });
});

describe("bestSlots", () => {
  const samples = [
    // Monday 18:00, three posts: median 300.
    { at: at("2026-10-05T18:10:00"), views: 100 },
    { at: at("2026-10-12T18:40:00"), views: 300 },
    { at: at("2026-10-19T18:00:00"), views: 900 },
    // Friday 12:00, three posts: median 500.
    { at: at("2026-10-09T12:00:00"), views: 500 },
    { at: at("2026-10-16T12:20:00"), views: 450 },
    { at: at("2026-10-23T12:59:00"), views: 600 },
    // Sunday 09:00, only two posts with huge views: not enough.
    { at: at("2026-10-11T09:00:00"), views: 50_000 },
    { at: at("2026-10-18T09:00:00"), views: 60_000 },
  ];

  it("ranks slots with enough posts by median views", () => {
    expect(bestSlots(samples, { utc: true })).toEqual([
      { weekday: 4, hour: 12, medianViews: 500, posts: 3 },
      { weekday: 0, hour: 18, medianViews: 300, posts: 3 },
    ]);
  });

  it("has nothing while every slot is short of posts", () => {
    expect(bestSlots(samples.slice(0, 2), { utc: true })).toEqual([]);
  });

  it("keeps at most the limit, breaking ties by more posts then earlier in the week", () => {
    const tied = [
      ...[1, 2, 3].map((week) => ({ at: at(`2026-10-${String(week * 7 + 1).padStart(2, "0")}T10:00:00`), views: 10 })),
      ...[1, 2].map((week) => ({ at: at(`2026-10-${String(week * 7 + 2).padStart(2, "0")}T08:00:00`), views: 10 })),
      ...[1, 2, 3, 4].map((week) => ({ at: at(`2026-09-${String(week * 7).padStart(2, "0")}T07:00:00`), views: 10 })),
    ];
    const slots = bestSlots(tied, { utc: true, minPosts: 2, limit: 2 });
    expect(slots.map(slotLabel)).toEqual(["Mon 07:00", "Thu 10:00"]);
  });
});

describe("nextOccurrence", () => {
  const now = at("2026-10-28T15:20:00"); // a Wednesday

  it("finds the slot later the same day", () => {
    expect(nextOccurrence({ weekday: 2, hour: 18 }, now, true)).toEqual(at("2026-10-28T18:00:00"));
  });

  it("goes to next week when the slot's hour has passed today", () => {
    expect(nextOccurrence({ weekday: 2, hour: 15 }, now, true)).toEqual(at("2026-11-04T15:00:00"));
  });

  it("finds a later weekday", () => {
    expect(nextOccurrence({ weekday: 0, hour: 9 }, now, true)).toEqual(at("2026-11-02T09:00:00"));
  });

  it("works in the machine's own timezone too", () => {
    const next = nextOccurrence({ weekday: 4, hour: 19 }, now, false);
    expect(slotOf(next, false)).toEqual({ weekday: 4, hour: 19 });
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(8 * 24 * 60 * 60 * 1000);
  });
});

describe("nextBestTime", () => {
  it("picks the soonest of the slots", () => {
    const now = at("2026-10-28T15:20:00");
    const slots = [
      { weekday: 0, hour: 9 },
      { weekday: 3, hour: 8 },
    ];
    expect(nextBestTime(slots, now, true)).toEqual(at("2026-10-29T08:00:00"));
  });

  it("refuses no slots", () => {
    expect(() => nextBestTime([], new Date(), true)).toThrow();
  });
});

describe("toDateTimeLocal", () => {
  it("writes the local time a datetime-local input reads back", () => {
    const date = new Date(2026, 10, 3, 7, 5);
    expect(toDateTimeLocal(date)).toBe("2026-11-03T07:05");
    expect(new Date(toDateTimeLocal(date)).getTime()).toBe(date.getTime());
  });
});
