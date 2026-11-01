"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { LocalTime } from "@/components/local-time";
import { bestSlots, DEFAULT_GUIDELINE, MIN_POSTS_PER_SLOT, slotLabel } from "@/lib/best-time";
import {
  breakdown,
  byCaptionStyle,
  byHour,
  byLength,
  byWeekday,
  CAPTION_STYLES,
  filterPosts,
  LENGTH_BUCKETS,
  lengthBucket,
  sortPosts,
  STAT_METRICS,
  type BreakdownRow,
  type SortColumn,
  type StatMetric,
  type StatPost,
} from "@/lib/stats";
import styles from "./stats.module.css";

export type StatPostView = Omit<StatPost, "publishedAt"> & { publishedAt: string };

const BAR_WIDTH = 120;
const BAR_HEIGHT = 10;
const COLUMN_WIDTH = 18;
const COLUMN_GAP = 6;
const CHART_HEIGHT = 80;

function subscribe() {
  return () => {};
}

const format = (value: number | null | undefined) =>
  value === null || value === undefined ? "–" : Math.round(value).toLocaleString("en");

const labelOf = (groups: Array<{ key: string; label: string }>, key: string) =>
  groups.find((group) => group.key === key)?.label ?? key;

// A date input's day in the viewer's timezone: its start, or the start of the next day for an end.
function dayStart(value: string, next: boolean): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day + (next ? 1 : 0));
}

// A bar scaled to the highest value, drawn like the post page's insight chart.
function Bar({ value, max, label }: { value: number | null; max: number; label: string }) {
  const width = value === null ? 0 : Math.max(2, (value / max) * BAR_WIDTH);
  return (
    <svg className={styles.bar} width={BAR_WIDTH} height={BAR_HEIGHT} viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`} role="img">
      <title>{`${label}: ${format(value)}`}</title>
      {value === null ? null : <rect width={width} height={BAR_HEIGHT} rx={2} />}
    </svg>
  );
}

function BreakdownTable({
  title,
  group,
  rows,
  metric,
  hideEmpty,
}: {
  title: string;
  group: string;
  rows: BreakdownRow[];
  metric: StatMetric;
  hideEmpty: boolean;
}) {
  const shown = hideEmpty ? rows.filter((row) => row.posts > 0) : rows;
  const max = Math.max(1, ...shown.map((row) => row.averages[metric] ?? 0));
  const metricLabel = STAT_METRICS.find((candidate) => candidate.metric === metric)!.label;
  return (
    <section>
      <h2>{title}</h2>
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>{group}</th>
              <th className={styles.number}>Posts</th>
              {STAT_METRICS.map((candidate) => (
                <th key={candidate.metric} className={styles.number}>
                  Avg {candidate.label.toLowerCase()}
                </th>
              ))}
              <th>Avg {metricLabel.toLowerCase()}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td className={styles.number}>{row.posts}</td>
                {STAT_METRICS.map((candidate) => (
                  <td key={candidate.metric} className={styles.number}>
                    {format(row.averages[candidate.metric])}
                  </td>
                ))}
                <td>
                  <Bar value={row.averages[metric]} max={max} label={`${row.label}, avg ${metricLabel.toLowerCase()}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// The 24 posting hours as columns of the chosen metric's average.
function HourChart({ rows, metric }: { rows: BreakdownRow[]; metric: StatMetric }) {
  const max = Math.max(1, ...rows.map((row) => row.averages[metric] ?? 0));
  const width = rows.length * (COLUMN_WIDTH + COLUMN_GAP) - COLUMN_GAP;
  const metricLabel = STAT_METRICS.find((candidate) => candidate.metric === metric)!.label.toLowerCase();
  return (
    <div className={styles.tableWrap}>
      <svg className={styles.hours} width={width} height={CHART_HEIGHT + 16} viewBox={`0 0 ${width} ${CHART_HEIGHT + 16}`} role="img">
        <title>{`Avg ${metricLabel} by posting hour`}</title>
        {rows.map((row, index) => {
          const value = row.averages[metric];
          const height = value === null ? 0 : Math.max(2, (value / max) * CHART_HEIGHT);
          const x = index * (COLUMN_WIDTH + COLUMN_GAP);
          return (
            <g key={row.key}>
              <title>{`${row.label}: ${row.posts} ${row.posts === 1 ? "post" : "posts"}, avg ${metricLabel} ${format(value)}`}</title>
              <rect className={styles.slot} x={x} y={0} width={COLUMN_WIDTH} height={CHART_HEIGHT} rx={2} />
              {value === null ? null : <rect x={x} y={CHART_HEIGHT - height} width={COLUMN_WIDTH} height={height} rx={2} />}
              {index % 3 === 0 ? (
                <text x={x + COLUMN_WIDTH / 2} y={CHART_HEIGHT + 13} textAnchor="middle">
                  {String(index).padStart(2, "0")}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const COLUMNS: Array<{ column: SortColumn; label: string; number: boolean }> = [
  { column: "publishedAt", label: "Published", number: false },
  { column: "username", label: "Account", number: false },
  { column: "seconds", label: "Length", number: true },
  { column: "captionStyle", label: "Captions", number: false },
  ...STAT_METRICS.map(({ metric, label }) => ({ column: metric, label, number: true })),
];

// Published posts compared by their latest insights, filtered by account and dates. Weekdays and hours are in the
// viewer's timezone: like LocalTime, the server-rendered HTML uses UTC and the browser switches as soon as it hydrates.
export function StatsView({ accounts, posts }: { accounts: Array<{ id: string; username: string }>; posts: StatPostView[] }) {
  const inBrowser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const utc = !inBrowser;
  const [accountId, setAccountId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [metric, setMetric] = useState<StatMetric>("views");
  const [sort, setSort] = useState<{ column: SortColumn; direction: "asc" | "desc" }>({ column: "publishedAt", direction: "desc" });

  const all = posts.map((post) => ({ ...post, publishedAt: new Date(post.publishedAt) }));
  const shown = filterPosts(all, { accountId: accountId || null, from: dayStart(from, false), to: dayStart(to, true) });
  const totals = breakdown(shown, [{ key: "all", label: "All" }], () => "all")[0];
  const slots = bestSlots(
    shown.flatMap((post) => (post.metrics.views === undefined ? [] : [{ at: post.publishedAt, views: post.metrics.views }])),
    { utc },
  );
  const sorted = sortPosts(shown, sort.column, sort.direction);

  function sortBy(column: SortColumn) {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: column === "username" || column === "captionStyle" ? "asc" : "desc" },
    );
  }

  return (
    <>
      <div className={styles.filters}>
        <Field label="Account">
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                @{account.username}
              </option>
            ))}
          </select>
        </Field>
        <Field label="From">
          <input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
        </Field>
        <Field label="Bars show">
          <select value={metric} onChange={(event) => setMetric(event.target.value as StatMetric)}>
            {STAT_METRICS.map((candidate) => (
              <option key={candidate.metric} value={candidate.metric}>
                Avg {candidate.label.toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {shown.length === 0 ? (
        <EmptyState>No published posts match these filters.</EmptyState>
      ) : (
        <>
          <dl className={styles.totals}>
            <div>
              <dt>Posts</dt>
              <dd>{totals.posts}</dd>
            </div>
            {STAT_METRICS.map((candidate) => (
              <div key={candidate.metric}>
                <dt>Avg {candidate.label.toLowerCase()}</dt>
                <dd>{format(totals.averages[candidate.metric])}</dd>
              </div>
            ))}
          </dl>
          <p className={styles.note}>
            Instagram&apos;s watch time and skip rate are not pulled, so only the metrics above are compared. A post without
            insights yet counts in Posts but not in the averages.
          </p>

          <h2>Best time to post</h2>
          <Card>
            {slots.length > 0 ? (
              <>
                <ol className={styles.slots}>
                  {slots.map((slot) => (
                    <li key={`${slot.weekday}-${slot.hour}`}>
                      <strong>{slotLabel(slot)}</strong> · median {format(slot.medianViews)} views over {slot.posts} posts
                    </li>
                  ))}
                </ol>
                <p className={styles.note}>
                  From these posts&apos; latest views, per weekday and hour in your timezone. A slot needs {MIN_POSTS_PER_SLOT}{" "}
                  posts to count.
                </p>
              </>
            ) : (
              <p className={styles.note}>
                Not enough data yet: no weekday and hour has {MIN_POSTS_PER_SLOT} published posts with views. As a general
                guideline, not worked out from your posts: {DEFAULT_GUIDELINE}
              </p>
            )}
          </Card>

          <BreakdownTable title="By clip length" group="Length" rows={byLength(shown)} metric={metric} hideEmpty={false} />
          <BreakdownTable title="By caption style" group="Captions" rows={byCaptionStyle(shown)} metric={metric} hideEmpty />
          <BreakdownTable title="By weekday" group="Weekday" rows={byWeekday(shown, utc)} metric={metric} hideEmpty={false} />
          <h2>By posting hour</h2>
          <HourChart rows={byHour(shown, utc)} metric={metric} />
          <BreakdownTable title="Hours with posts" group="Hour" rows={byHour(shown, utc)} metric={metric} hideEmpty />

          <h2>All posts</h2>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((column) => {
                    const active = sort.column === column.column;
                    return (
                      <th
                        key={column.column}
                        className={column.number ? styles.number : undefined}
                        aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
                      >
                        <button type="button" className={styles.sort} onClick={() => sortBy(column.column)}>
                          {column.label}
                          {active ? (sort.direction === "asc" ? " ↑" : " ↓") : null}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.map((post) => (
                  <tr key={post.id}>
                    <td>
                      <Link href={`/posts/${post.id}`}>
                        <LocalTime date={post.publishedAt} />
                      </Link>
                    </td>
                    <td>@{post.username}</td>
                    <td className={styles.number} title={labelOf(LENGTH_BUCKETS, lengthBucket(post.seconds))}>
                      {Math.round(post.seconds)} s
                    </td>
                    <td>{labelOf(CAPTION_STYLES, post.captionStyle)}</td>
                    {STAT_METRICS.map((candidate) => (
                      <td key={candidate.metric} className={styles.number}>
                        {format(post.metrics[candidate.metric])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
