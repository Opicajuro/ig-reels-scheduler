import { describe, expect, it } from "vitest";
import { addMonths, dayKey, dayKeyOf, monthGrid, monthOf } from "./calendar";

describe("monthGrid", () => {
  it("covers a month with whole Monday-first weeks", () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthGrid({ year: 2026, month: 9 });
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0].map((day) => day.key)).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ]);
    expect(weeks[0].map((day) => day.inMonth)).toEqual([false, false, false, true, true, true, true]);
    expect(weeks[4].at(-1)).toEqual({ key: "2026-11-01", day: 1, inMonth: false });
    expect(weeks.flat().filter((day) => day.inMonth)).toHaveLength(31);
  });

  it("needs only four weeks for a February that starts on a Monday", () => {
    const weeks = monthGrid({ year: 2021, month: 1 });
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().every((day) => day.inMonth)).toBe(true);
  });

  it("takes six weeks for a long month that starts on a Sunday", () => {
    // August 2027 starts on a Sunday.
    const weeks = monthGrid({ year: 2027, month: 7 });
    expect(weeks).toHaveLength(6);
    expect(weeks[0][6]).toEqual({ key: "2027-08-01", day: 1, inMonth: true });
  });

  it("handles a leap day", () => {
    expect(monthGrid({ year: 2028, month: 1 }).flat().filter((day) => day.inMonth)).toHaveLength(29);
  });
});

describe("addMonths", () => {
  it("rolls over the year both ways", () => {
    expect(addMonths({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(addMonths({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(addMonths({ year: 2026, month: 5 }, -18)).toEqual({ year: 2024, month: 11 });
    expect(addMonths({ year: 2026, month: 5 }, 0)).toEqual({ year: 2026, month: 5 });
  });
});

describe("dayKeyOf and monthOf", () => {
  it("use UTC when asked", () => {
    const moment = new Date("2026-10-31T23:30:00Z");
    expect(dayKeyOf(moment, true)).toBe("2026-10-31");
    expect(monthOf(moment, true)).toEqual({ year: 2026, month: 9 });
  });

  it("use the local day otherwise", () => {
    const moment = new Date(2026, 11, 31, 23, 59);
    expect(dayKeyOf(moment, false)).toBe("2026-12-31");
    expect(monthOf(moment, false)).toEqual({ year: 2026, month: 11 });
  });

  it("pads months and days", () => {
    expect(dayKey(2026, 0, 5)).toBe("2026-01-05");
  });
});
