// The month grid of the Scheduled calendar. Weeks start on Monday; days are worked out in UTC arithmetic, so the grid
// does not depend on the machine's timezone. A post's day is its day in the viewer's timezone, or in UTC on the server.

export type Month = { year: number; month: number };
export type CalendarDay = { key: string; day: number; inMonth: boolean };

const pad = (value: number) => String(value).padStart(2, "0");

export function dayKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

export function dayKeyOf(date: Date, utc: boolean): string {
  return utc
    ? dayKey(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    : dayKey(date.getFullYear(), date.getMonth(), date.getDate());
}

export function monthOf(date: Date, utc: boolean): Month {
  return utc ? { year: date.getUTCFullYear(), month: date.getUTCMonth() } : { year: date.getFullYear(), month: date.getMonth() };
}

export function addMonths({ year, month }: Month, delta: number): Month {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

// The whole weeks that cover the month, with the days of the months around it filling the first and last week.
export function monthGrid({ year, month }: Month): CalendarDay[][] {
  const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((lead + length) / 7) }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const date = new Date(Date.UTC(year, month, 1 - lead + week * 7 + weekday));
      return {
        key: dayKeyOf(date, true),
        day: date.getUTCDate(),
        inMonth: date.getUTCMonth() === month,
      };
    }),
  );
}
