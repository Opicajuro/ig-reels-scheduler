"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import type { PostStatus } from "@/generated/prisma/enums";
import { Button } from "@/components/button";
import { statusLabel } from "@/components/status-badge";
import { addMonths, dayKeyOf, monthGrid, monthOf } from "@/lib/calendar";
import styles from "./scheduled.module.css";

export type CalendarPost = { id: string; scheduledAt: string; status: PostStatus; username: string; caption: string };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function subscribe() {
  return () => {};
}

// Posts on a month grid, each on its day in the viewer's timezone. Like LocalTime, the server-rendered HTML uses UTC
// and the browser switches to local days as soon as it hydrates. A post opens its page.
export function PostCalendar({ posts, now }: { posts: CalendarPost[]; now: string }) {
  const inBrowser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const utc = !inBrowser;
  const [offset, setOffset] = useState(0);
  const shown = addMonths(monthOf(new Date(now), utc), offset);
  const today = dayKeyOf(new Date(now), utc);

  const byDay = new Map<string, Array<CalendarPost & { time: string }>>();
  for (const post of posts) {
    const at = new Date(post.scheduledAt);
    const time = utc ? at.toISOString().slice(11, 16) : at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const key = dayKeyOf(at, utc);
    byDay.set(key, [...(byDay.get(key) ?? []), { ...post, time }]);
  }
  for (const day of byDay.values()) day.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const title = `${MONTHS[shown.month]} ${shown.year}`;

  return (
    <div className={styles.calendar}>
      <div className={styles.calendarHead}>
        <Button type="button" size="sm" aria-label="Previous month" onClick={() => setOffset(offset - 1)}>
          ←
        </Button>
        <h2 aria-live="polite">{title}</h2>
        <Button type="button" size="sm" aria-label="Next month" onClick={() => setOffset(offset + 1)}>
          →
        </Button>
        {offset !== 0 ? (
          <Button type="button" size="sm" onClick={() => setOffset(0)}>
            Today
          </Button>
        ) : null}
      </div>
      <table className={styles.month}>
        <caption className={styles.hidden}>Posts in {title}</caption>
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday} scope="col">
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {monthGrid(shown).map((week) => (
            <tr key={week[0].key}>
              {week.map((day) => (
                <td
                  key={day.key}
                  className={`${day.inMonth ? "" : styles.outside} ${day.key === today ? styles.today : ""}`}
                  aria-current={day.key === today ? "date" : undefined}
                >
                  <span className={styles.dayNumber}>{day.day}</span>
                  {(byDay.get(day.key) ?? []).map((post) => (
                    <Link
                      key={post.id}
                      href={`/posts/${post.id}`}
                      className={styles.entry}
                      data-status={post.status}
                      aria-label={`${post.time} @${post.username}, ${statusLabel(post.status)}`}
                      title={post.caption || "No caption"}
                    >
                      <time dateTime={post.scheduledAt}>{post.time}</time> <span>@{post.username}</span>
                    </Link>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
