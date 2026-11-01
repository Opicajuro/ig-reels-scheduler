// The Stats page: published posts compared by their latest insight pull, and broken down by clip length, caption style,
// posting weekday and posting hour. Weekday and hour follow slotOf: the viewer's timezone in the browser, UTC on the
// server.
import { slotOf, WEEKDAYS } from "./best-time";

export const STAT_METRICS = [
  { metric: "views", label: "Views" },
  { metric: "reach", label: "Reach" },
  { metric: "likes", label: "Likes" },
  { metric: "comments", label: "Comments" },
  { metric: "shares", label: "Shares" },
  { metric: "saved", label: "Saves" },
] as const;
export type StatMetric = (typeof STAT_METRICS)[number]["metric"];

export type StatPost = {
  id: string;
  accountId: string;
  username: string;
  publishedAt: Date;
  seconds: number;
  captionStyle: string;
  /** the latest pull's values; a metric that pull did not return is missing */
  metrics: Partial<Record<string, number>>;
};

export type BreakdownRow = {
  key: string;
  label: string;
  posts: number;
  /** the mean of each metric over the posts that have it, or null when none has */
  averages: Record<StatMetric, number | null>;
};

// A clip's length: "15–30 s" holds 15 to 30 seconds, and each later bucket starts just above the one before.
export const LENGTH_BUCKETS = [
  { key: "under15", label: "Under 15 s" },
  { key: "15-30", label: "15–30 s" },
  { key: "30-45", label: "30–45 s" },
  { key: "45-60", label: "45–60 s" },
  { key: "over60", label: "Over 60 s" },
];

export function lengthBucket(seconds: number): string {
  if (seconds < 0) throw new Error(`a clip cannot be ${seconds} s long`);
  if (seconds < 15) return "under15";
  if (seconds <= 30) return "15-30";
  if (seconds <= 45) return "30-45";
  if (seconds <= 60) return "45-60";
  return "over60";
}

export const CAPTION_STYLES = [
  { key: "classic", label: "Classic" },
  { key: "yellow", label: "Yellow" },
  { key: "box", label: "Box" },
  { key: "words", label: "Word by word" },
  { key: "none", label: "No captions" },
  { key: "upload", label: "Uploaded video" },
  { key: "deleted", label: "Project deleted" },
];

// The caption style of a post's video, from the project it was made in: none for a video uploaded directly, and
// undefined when that project was deleted. The project settings are read as they are now.
export function captionStyleOf(
  sourceProjectId: string | null,
  project: { withCaptions: boolean; captionPreset: string | null } | undefined,
): string {
  if (sourceProjectId === null) return "upload";
  if (!project) return "deleted";
  if (!project.withCaptions) return "none";
  const preset = project.captionPreset ?? "classic";
  if (!CAPTION_STYLES.some((style) => style.key === preset)) throw new Error(`unknown caption preset "${preset}"`);
  return preset;
}

// The values of a post's latest pull. Each pull stores all its metrics with the same fetchedAt.
export function latestPull(insights: Array<{ metric: string; value: number; fetchedAt: Date }>): Record<string, number> {
  if (insights.length === 0) return {};
  const latest = Math.max(...insights.map((insight) => insight.fetchedAt.getTime()));
  return Object.fromEntries(
    insights.filter((insight) => insight.fetchedAt.getTime() === latest).map((insight) => [insight.metric, insight.value]),
  );
}

// `from` and `to` are moments; the page turns its date inputs into the start and end of those days in local time.
export function filterPosts(
  posts: StatPost[],
  { accountId, from, to }: { accountId: string | null; from: Date | null; to: Date | null },
): StatPost[] {
  return posts.filter(
    (post) =>
      (accountId === null || post.accountId === accountId) &&
      (from === null || post.publishedAt.getTime() >= from.getTime()) &&
      (to === null || post.publishedAt.getTime() < to.getTime()),
  );
}

function averagesOf(posts: StatPost[]): Record<StatMetric, number | null> {
  return Object.fromEntries(
    STAT_METRICS.map(({ metric }) => {
      const values = posts.flatMap((post) => (post.metrics[metric] === undefined ? [] : [post.metrics[metric]]));
      return [metric, values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length];
    }),
  ) as Record<StatMetric, number | null>;
}

// One row per group, in the order given, including groups with no posts.
export function breakdown(
  posts: StatPost[],
  groups: Array<{ key: string; label: string }>,
  keyOf: (post: StatPost) => string,
): BreakdownRow[] {
  return groups.map((group) => {
    const members = posts.filter((post) => keyOf(post) === group.key);
    return { ...group, posts: members.length, averages: averagesOf(members) };
  });
}

export function byLength(posts: StatPost[]): BreakdownRow[] {
  return breakdown(posts, LENGTH_BUCKETS, (post) => lengthBucket(post.seconds));
}

export function byCaptionStyle(posts: StatPost[]): BreakdownRow[] {
  return breakdown(posts, CAPTION_STYLES, (post) => post.captionStyle);
}

export function byWeekday(posts: StatPost[], utc: boolean): BreakdownRow[] {
  return breakdown(
    posts,
    WEEKDAYS.map((label, weekday) => ({ key: String(weekday), label })),
    (post) => String(slotOf(post.publishedAt, utc).weekday),
  );
}

export function byHour(posts: StatPost[], utc: boolean): BreakdownRow[] {
  return breakdown(
    posts,
    Array.from({ length: 24 }, (_, hour) => ({ key: String(hour), label: `${String(hour).padStart(2, "0")}:00` })),
    (post) => String(slotOf(post.publishedAt, utc).hour),
  );
}

export type SortColumn = "publishedAt" | "username" | "seconds" | "captionStyle" | StatMetric;

// Posts sorted by a column. A post without the metric goes last either way; ties keep the newest first.
export function sortPosts(posts: StatPost[], column: SortColumn, direction: "asc" | "desc"): StatPost[] {
  const sign = direction === "asc" ? 1 : -1;
  const valueOf = (post: StatPost): string | number | undefined =>
    column === "publishedAt"
      ? post.publishedAt.getTime()
      : column === "username" || column === "captionStyle" || column === "seconds"
        ? post[column]
        : post.metrics[column];
  return [...posts].sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1;
    } else if (left !== right) {
      return (typeof left === "string" ? left.localeCompare(String(right)) : left - Number(right)) * sign;
    }
    return b.publishedAt.getTime() - a.publishedAt.getTime();
  });
}
