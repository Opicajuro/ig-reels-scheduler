import { describe, expect, it } from "vitest";
import {
  byCaptionStyle,
  byHour,
  byLength,
  byWeekday,
  captionStyleOf,
  filterPosts,
  latestPull,
  lengthBucket,
  sortPosts,
  type StatPost,
} from "./stats";

const post = (id: string, overrides: Partial<StatPost>): StatPost => ({
  id,
  accountId: "acc-1",
  username: "one",
  publishedAt: new Date("2026-10-26T18:00:00Z"),
  seconds: 30,
  captionStyle: "classic",
  metrics: {},
  ...overrides,
});

describe("lengthBucket", () => {
  it("puts each length in its bucket", () => {
    expect([0, 14.9, 15, 30, 30.5, 45, 60, 61].map(lengthBucket)).toEqual([
      "under15",
      "under15",
      "15-30",
      "15-30",
      "30-45",
      "30-45",
      "45-60",
      "over60",
    ]);
  });

  it("refuses a negative length", () => {
    expect(() => lengthBucket(-1)).toThrow();
  });
});

describe("captionStyleOf", () => {
  it("names the style of the project the video came from", () => {
    expect(captionStyleOf(null, undefined)).toBe("upload");
    expect(captionStyleOf("p1", undefined)).toBe("deleted");
    expect(captionStyleOf("p1", { withCaptions: false, captionPreset: "box" })).toBe("none");
    expect(captionStyleOf("p1", { withCaptions: true, captionPreset: null })).toBe("classic");
    expect(captionStyleOf("p1", { withCaptions: true, captionPreset: "words" })).toBe("words");
  });

  it("refuses an unknown preset", () => {
    expect(() => captionStyleOf("p1", { withCaptions: true, captionPreset: "neon" })).toThrow();
  });
});

describe("latestPull", () => {
  it("keeps only the values of the newest pull", () => {
    const first = new Date("2026-10-26T19:00:00Z");
    const second = new Date("2026-10-27T18:00:00Z");
    expect(
      latestPull([
        { metric: "views", value: 10, fetchedAt: first },
        { metric: "likes", value: 1, fetchedAt: first },
        { metric: "views", value: 50, fetchedAt: second },
      ]),
    ).toEqual({ views: 50 });
    expect(latestPull([])).toEqual({});
  });
});

describe("filterPosts", () => {
  const posts = [
    post("a", { publishedAt: new Date("2026-10-01T10:00:00Z") }),
    post("b", { publishedAt: new Date("2026-10-15T10:00:00Z"), accountId: "acc-2" }),
    post("c", { publishedAt: new Date("2026-10-20T10:00:00Z") }),
  ];

  it("keeps the account's posts within the range, the end excluded", () => {
    expect(filterPosts(posts, { accountId: null, from: null, to: null }).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(filterPosts(posts, { accountId: "acc-1", from: null, to: null }).map((p) => p.id)).toEqual(["a", "c"]);
    expect(
      filterPosts(posts, {
        accountId: null,
        from: new Date("2026-10-15T10:00:00Z"),
        to: new Date("2026-10-20T10:00:00Z"),
      }).map((p) => p.id),
    ).toEqual(["b"]);
  });
});

describe("breakdowns", () => {
  const posts = [
    post("a", { seconds: 12, captionStyle: "none", metrics: { views: 100, likes: 4 } }),
    post("b", { seconds: 28, metrics: { views: 300 } }),
    post("c", { seconds: 30, publishedAt: new Date("2026-10-27T07:00:00Z"), metrics: {} }),
  ];

  it("averages each metric over the posts that have it, by length bucket", () => {
    const rows = byLength(posts);
    expect(rows.map((row) => [row.key, row.posts])).toEqual([
      ["under15", 1],
      ["15-30", 2],
      ["30-45", 0],
      ["45-60", 0],
      ["over60", 0],
    ]);
    expect(rows[1].averages.views).toBe(300);
    expect(rows[1].averages.likes).toBeNull();
    expect(rows[0].averages.likes).toBe(4);
    expect(rows[2].averages.views).toBeNull();
  });

  it("groups by caption style", () => {
    const rows = byCaptionStyle(posts);
    expect(rows.find((row) => row.key === "classic")?.posts).toBe(2);
    expect(rows.find((row) => row.key === "none")?.averages.views).toBe(100);
  });

  it("groups by weekday and hour", () => {
    const weekdays = byWeekday(posts, true);
    expect(weekdays).toHaveLength(7);
    expect(weekdays[0]).toMatchObject({ label: "Mon", posts: 2 });
    expect(weekdays[1]).toMatchObject({ label: "Tue", posts: 1 });
    const hours = byHour(posts, true);
    expect(hours).toHaveLength(24);
    expect(hours[18]).toMatchObject({ label: "18:00", posts: 2 });
    expect(hours[7].posts).toBe(1);
  });
});

describe("sortPosts", () => {
  const posts = [
    post("a", { publishedAt: new Date("2026-10-01T00:00:00Z"), username: "zed", metrics: { views: 5 } }),
    post("b", { publishedAt: new Date("2026-10-02T00:00:00Z"), username: "amy", metrics: {} }),
    post("c", { publishedAt: new Date("2026-10-03T00:00:00Z"), username: "max", metrics: { views: 50 } }),
  ];

  it("sorts by a metric with posts lacking it last", () => {
    expect(sortPosts(posts, "views", "desc").map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(sortPosts(posts, "views", "asc").map((p) => p.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts by text and by time", () => {
    expect(sortPosts(posts, "username", "asc").map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(sortPosts(posts, "publishedAt", "desc").map((p) => p.id)).toEqual(["c", "b", "a"]);
  });
});
