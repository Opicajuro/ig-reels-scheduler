import { describe, expect, it } from "vitest";
import {
  addHighlight,
  formatTime,
  lengthLimits,
  moveHighlight,
  parseHighlightsJson,
  parseTranscript,
  pxToSeconds,
  removeHighlight,
  resizeHighlight,
  secondsToPx,
  snap,
  validateHighlights,
  wordsInRange,
} from "./highlights";
import { UserError } from "./user-error";

const limits = lengthLimits(100);

describe("lengthLimits", () => {
  it("is the clip length setting's range, or the whole video when it is shorter than the shortest clip", () => {
    expect(lengthLimits(600)).toEqual({ min: 15, max: 180 });
    expect(lengthLimits(100)).toEqual({ min: 15, max: 100 });
    expect(lengthLimits(10)).toEqual({ min: 10, max: 10 });
  });
});

describe("validateHighlights", () => {
  it("returns the highlights in time order, touching ones allowed", () => {
    expect(
      validateHighlights(
        [
          { start: 50, length: 20 },
          { start: 0.5, length: 15.5 },
          { start: 16, length: 34 },
        ],
        100,
      ),
    ).toEqual([
      { start: 0.5, length: 15.5 },
      { start: 16, length: 34 },
      { start: 50, length: 20 },
    ]);
  });

  it("refuses overlapping highlights", () => {
    const overlapping = [
      { start: 30, length: 20 },
      { start: 10, length: 20.5 },
    ];
    expect(() => validateHighlights(overlapping, 100)).toThrow(UserError);
    expect(() => validateHighlights(overlapping, 100)).toThrow("0:10 and 0:30 overlap");
  });

  it("refuses a highlight outside the video", () => {
    expect(() => validateHighlights([{ start: -0.5, length: 20 }], 100)).toThrow("within the 100s video");
    expect(() => validateHighlights([{ start: 85, length: 15.5 }], 100)).toThrow("within the 100s video");
    expect(validateHighlights([{ start: 85, length: 15 }], 100)).toEqual([{ start: 85, length: 15 }]);
  });

  it("refuses a highlight shorter or longer than a clip may be", () => {
    expect(() => validateHighlights([{ start: 0, length: 14.5 }], 100)).toThrow("must be 15 to 100 seconds long");
    expect(() => validateHighlights([{ start: 0, length: 180.5 }], 600)).toThrow("must be 15 to 180 seconds long");
    expect(validateHighlights([{ start: 0, length: 180 }], 600)).toHaveLength(1);
    expect(validateHighlights([{ start: 0, length: 10 }], 10)).toHaveLength(1);
  });

  it("refuses times off the half-second steps, malformed items, none and too many", () => {
    expect(() => validateHighlights([{ start: 0.25, length: 20 }], 100)).toThrow("half seconds");
    expect(() => validateHighlights([{ start: "0", length: 20 }], 100)).toThrow("half seconds");
    expect(() => validateHighlights([null], 100)).toThrow("half seconds");
    expect(() => validateHighlights({}, 100)).toThrow("must be a list");
    expect(() => validateHighlights([], 100)).toThrow("at least one");
    const eleven = Array.from({ length: 11 }, (_, index) => ({ start: index * 15, length: 15 }));
    expect(() => validateHighlights(eleven, 600)).toThrow("at most 10");
  });

  it("parses the timeline's JSON", () => {
    expect(parseHighlightsJson('[{"start":1,"length":15}]', 100)).toEqual([{ start: 1, length: 15 }]);
    expect(() => parseHighlightsJson("[{", 100)).toThrow("not valid JSON");
  });
});

describe("timeline math", () => {
  it("converts between seconds and pixels both ways", () => {
    expect(secondsToPx(25, 100, 800)).toBe(200);
    expect(pxToSeconds(200, 100, 800)).toBe(25);
    expect(pxToSeconds(secondsToPx(37.5, 120, 333), 120, 333)).toBeCloseTo(37.5);
    expect(() => pxToSeconds(10, 100, 0)).toThrow("no width");
  });

  it("snaps to half seconds", () => {
    expect(snap(10.24)).toBe(10);
    expect(snap(10.26)).toBe(10.5);
    expect(snap(10.74)).toBe(10.5);
  });
});

describe("moveHighlight", () => {
  const highlights = [
    { start: 10, length: 20 },
    { start: 40, length: 20 },
    { start: 70, length: 15 },
  ];

  it("moves by a snapped amount and keeps the length", () => {
    expect(moveHighlight(highlights, 1, 42.3, 100)[1]).toEqual({ start: 42.5, length: 20 });
    expect(moveHighlight(highlights, 1, 39.5, 100)[1]).toEqual({ start: 39.5, length: 20 });
  });

  it("stops at its neighbours and the ends of the video", () => {
    expect(moveHighlight(highlights, 1, 20, 100)[1]).toEqual({ start: 30, length: 20 });
    expect(moveHighlight(highlights, 1, 65, 100)[1]).toEqual({ start: 50, length: 20 });
    expect(moveHighlight(highlights, 0, -5, 100)[0]).toEqual({ start: 0, length: 20 });
    expect(moveHighlight(highlights, 2, 99, 100)[2]).toEqual({ start: 85, length: 15 });
  });

  it("leaves the others as they are", () => {
    const moved = moveHighlight(highlights, 1, 45, 100);
    expect(moved[0]).toBe(highlights[0]);
    expect(moved[2]).toBe(highlights[2]);
  });
});

describe("resizeHighlight", () => {
  const highlights = [
    { start: 10, length: 20 },
    { start: 40, length: 20 },
  ];

  it("moves the end, keeping the start", () => {
    expect(resizeHighlight(highlights, 0, "end", 25.5, 100, limits)[0]).toEqual({ start: 10, length: 15.5 });
  });

  it("moves the start, keeping the end", () => {
    expect(resizeHighlight(highlights, 1, "start", 35, 100, limits)[1]).toEqual({ start: 35, length: 25 });
  });

  it("keeps the length within its limits", () => {
    expect(resizeHighlight(highlights, 0, "end", 12, 100, limits)[0]).toEqual({ start: 10, length: 15 });
    expect(resizeHighlight(highlights, 1, "start", 59, 100, limits)[1]).toEqual({ start: 45, length: 15 });
    const long = [{ start: 0, length: 20 }];
    expect(resizeHighlight(long, 0, "end", 400, 600, lengthLimits(600))[0]).toEqual({ start: 0, length: 180 });
  });

  it("stops at its neighbours and the ends of the video", () => {
    expect(resizeHighlight(highlights, 0, "end", 45, 100, limits)[0]).toEqual({ start: 10, length: 30 });
    expect(resizeHighlight(highlights, 1, "start", 20, 100, limits)[1]).toEqual({ start: 30, length: 30 });
    expect(resizeHighlight(highlights, 1, "end", 120, 100, limits)[1]).toEqual({ start: 40, length: 60 });
    expect(resizeHighlight(highlights, 0, "start", -3, 100, limits)[0]).toEqual({ start: 0, length: 30 });
  });
});

describe("addHighlight and removeHighlight", () => {
  const highlights = [
    { start: 10, length: 20 },
    { start: 60, length: 20 },
  ];

  it("adds one at the playhead, in time order", () => {
    expect(addHighlight(highlights, 35.3, 15, 100, limits)).toEqual([
      { start: 10, length: 20 },
      { start: 35, length: 15 },
      { start: 60, length: 20 },
    ]);
  });

  it("moves it back, or shortens it, to fit the gap it is in", () => {
    expect(addHighlight(highlights, 50, 15, 100, limits)?.[1]).toEqual({ start: 45, length: 15 });
    expect(addHighlight(highlights, 35, 60, 100, limits)?.[1]).toEqual({ start: 30, length: 30 });
    expect(addHighlight(highlights, 95, 15, 100, limits)?.[2]).toEqual({ start: 85, length: 15 });
  });

  it("is null on a highlight, in a gap shorter than the shortest clip, or with as many as allowed", () => {
    expect(addHighlight(highlights, 15, 15, 100, limits)).toBeNull();
    expect(addHighlight(highlights, 5, 15, 100, limits)).toBeNull();
    const ten = Array.from({ length: 10 }, (_, index) => ({ start: index * 20, length: 15 }));
    expect(addHighlight(ten, 196, 15, 300, lengthLimits(300))).toBeNull();
  });

  it("removes one", () => {
    expect(removeHighlight(highlights, 0)).toEqual([{ start: 60, length: 20 }]);
  });
});

describe("words and times", () => {
  const words = [
    { text: "hello", startMs: 900, endMs: 1200 },
    { text: "there", startMs: 1200, endMs: 1500 },
    { text: "friend", startMs: 3000, endMs: 3400 },
  ];

  it("lists the words that start in a highlight", () => {
    expect(wordsInRange(words, { start: 1, length: 2 })).toBe("there");
    expect(wordsInRange(words, { start: 0, length: 3.5 })).toBe("hello there friend");
    expect(wordsInRange(words, { start: 4, length: 2 })).toBe("");
  });

  it("checks a stored transcript", () => {
    expect(parseTranscript(words)).toBe(words);
    expect(() => parseTranscript([{ text: "a", startMs: "0", endMs: 1 }])).toThrow("malformed");
    expect(() => parseTranscript("words")).toThrow("malformed");
  });

  it("formats times with their half second", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(65.5)).toBe("1:05.5");
    expect(formatTime(3725)).toBe("1:02:05");
  });
});
