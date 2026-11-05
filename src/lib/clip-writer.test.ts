import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  applySuggestions,
  cancelClipWriting,
  failInterruptedWrites,
  parseSuggestion,
  parseSuggestionAnswer,
  runClipWriter,
  spokenWords,
  SPOKEN_MAX,
  startClipWriting,
  suggestedDescription,
  suggestionPrompt,
  suggestionSchema,
  WRITE_CLOSED_ERROR,
  type ClipWriterQueue,
} from "./clip-writer";
import { writeFakeEngines } from "./fake-slideshow-engines";
import { startLlamaServer, type StartLlm } from "./llm-script";
import type { StartupWorkJobs } from "./queues";
import { UserError } from "./user-error";

type Row = Record<string, unknown>;

const WORDS = [
  { text: "Coffee", startMs: 0, endMs: 300, lineStart: true },
  { text: "beats", startMs: 300, endMs: 600 },
  { text: "tea", startMs: 600, endMs: 900 },
];

function clipRow(id: string, extra: Row = {}): Row {
  return {
    id,
    name: id,
    ownerId: "o1",
    words: WORDS,
    start: 0,
    length: 30,
    musicTrack: null,
    title: null,
    description: null,
    aiWriteId: null,
    aiWriteStep: null,
    aiWriteError: null,
    aiSuggestion: null,
    project: { name: "Morning show", transcript: null },
    ...extra,
  };
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === "project") return row.ownerId === (want as Row).ownerId;
    if (want !== null && typeof want === "object" && "in" in want) return (want.in as unknown[]).includes(row[key]);
    if (want !== null && typeof want === "object" && "not" in want) return row[key] !== want.not;
    return row[key] === want;
  });
}

function stored(data: Row): Row {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === Prisma.DbNull ? null : value]));
}

const copy = (row: Row | undefined) => (row ? { ...row } : null);

function fakeDb(rows: Row[], script = "installed", onWrite: (row: Row, data: Row) => void = () => {}) {
  const state = { clips: rows.map((row) => ({ ...row })), steps: [] as string[] };
  const db = {
    slideshowEngine: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id, status: where.id === "script" ? script : "installed" }) },
    clip: {
      findMany: async ({ where }: { where: Row }) => state.clips.filter((row) => matches(row, where)).map((row) => ({ ...row })),
      findFirst: async ({ where }: { where: Row }) => copy(state.clips.find((row) => matches(row, where))),
      findUnique: async ({ where }: { where: Row }) => copy(state.clips.find((row) => row.id === where.id)),
      count: async ({ where }: { where: Row }) => state.clips.filter((row) => matches(row, where)).length,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.clips.filter((row) => matches(row, where));
        for (const row of hit) {
          Object.assign(row, stored(data));
          if (typeof data.aiWriteStep === "string") state.steps.push(`${String(row.id)}: ${data.aiWriteStep}`);
          onWrite(row, data);
        }
        return { count: hit.length };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.clips.find((clip) => clip.id === where.id);
        if (!row) throw new Error("no such clip");
        return Object.assign(row, stored(data));
      },
    },
    $transaction: async (writes: Promise<unknown>[]) => Promise.all(writes),
  };
  return { db: db as unknown as PrismaClient, state };
}

describe("suggestionSchema and suggestionPrompt", () => {
  it("asks for a short title, a description and 3 to 5 lowercase hashtags", () => {
    const schema = suggestionSchema();
    expect(schema.required).toEqual(["title", "description", "hashtags"]);
    expect(schema.properties.title).toEqual({ type: "string", minLength: 1, maxLength: 60 });
    expect(schema.properties.hashtags).toMatchObject({ minItems: 3, maxItems: 5, items: { type: "string", pattern: "^[a-z0-9_]{2,30}$" } });
    expect(schema.additionalProperties).toBe(false);
  });

  it("gives the project's name and what is said", () => {
    const prompt = suggestionPrompt("Morning show", "Coffee beats tea");
    expect(prompt).toContain('"Morning show"');
    expect(prompt).toContain('"""Coffee beats tea"""');
    expect(prompt).toContain("at most 60 characters");
    expect(prompt).toContain("English");
  });
});

describe("parseSuggestionAnswer", () => {
  const good = { title: " Why coffee wins ", description: "Coffee beats tea. Here is why.", hashtags: ["coffee", "tea", "morning_routine"] };
  const answer = (change: Row) => JSON.stringify({ ...good, ...change });

  it("trims the title and description", () => {
    expect(parseSuggestionAnswer(JSON.stringify(good))).toEqual({
      title: "Why coffee wins",
      description: "Coffee beats tea. Here is why.",
      hashtags: ["coffee", "tea", "morning_routine"],
    });
  });

  it("refuses answers that break the rules", () => {
    expect(() => parseSuggestionAnswer("{")).toThrow("not JSON");
    expect(() => parseSuggestionAnswer(answer({ title: "x".repeat(61) }))).toThrow("title");
    expect(() => parseSuggestionAnswer(answer({ title: "  " }))).toThrow("title");
    expect(() => parseSuggestionAnswer(answer({ description: "One. Two. Three. Four." }))).toThrow("3 sentences");
    expect(() => parseSuggestionAnswer(answer({ description: "x".repeat(301) }))).toThrow("description");
    expect(() => parseSuggestionAnswer(answer({ description: "Great #coffee." }))).toThrow("hashtag in it");
    expect(() => parseSuggestionAnswer(answer({ hashtags: ["coffee", "tea"] }))).toThrow("2 hashtags");
    expect(() => parseSuggestionAnswer(answer({ hashtags: ["a1", "b2", "c3", "d4", "e5", "f6"] }))).toThrow("6 hashtags");
    expect(() => parseSuggestionAnswer(answer({ hashtags: ["coffee", "Tea", "milk"] }))).toThrow('"Tea"');
    expect(() => parseSuggestionAnswer(answer({ hashtags: ["coffee", "green tea", "milk"] }))).toThrow('"green tea"');
    expect(() => parseSuggestionAnswer(answer({ hashtags: ["coffee", "#tea", "milk"] }))).toThrow('"#tea"');
    expect(() => parseSuggestionAnswer(answer({ hashtags: ["coffee", "tea", "coffee"] }))).toThrow("repeats");
    expect(() => parseSuggestionAnswer(JSON.stringify({ title: "x", description: "y" }))).toThrow("lacks");
  });
});

describe("spokenWords", () => {
  it("reads the clip's own words first, then the project's transcript over the clip", () => {
    expect(spokenWords({ words: WORDS, start: 0, length: 30 }, [{ text: "ignored", startMs: 0, endMs: 1 }])).toBe("Coffee beats tea");
    const transcript = [
      { text: "before", startMs: 1000, endMs: 1500 },
      { text: "inside", startMs: 10_000, endMs: 10_500 },
      { text: "too", startMs: 39_000, endMs: 39_500 },
      { text: "after", startMs: 41_000, endMs: 41_500 },
    ];
    expect(spokenWords({ words: null, start: 10, length: 30 }, transcript)).toBe("inside too");
    expect(spokenWords({ words: null, start: 10, length: 30 }, null)).toBe("");
  });

  it("cuts a long clip's words at a word", () => {
    const long = Array.from({ length: 2000 }, (_, index) => ({ text: "word", startMs: index, endMs: index + 1, ...(index === 0 ? { lineStart: true } : {}) }));
    const spoken = spokenWords({ words: long, start: 0, length: 30 }, null);
    expect(spoken.length).toBeLessThanOrEqual(SPOKEN_MAX);
    expect(spoken.endsWith("word")).toBe(true);
  });
});

function fakeQueue(fail = false) {
  const sent: [string, string[]][] = [];
  const queue: ClipWriterQueue = {
    send: async (writeId, clipIds) => {
      if (fail) throw new Error("pg-boss is down");
      sent.push([writeId, clipIds]);
      return "job-1";
    },
  };
  return { queue, sent };
}

describe("startClipWriting", () => {
  it("queues one job for all the clips and marks them", async () => {
    const { db, state } = fakeDb([clipRow("c1"), clipRow("c2", { words: null, project: { name: "Show", transcript: [{ text: "hi", startMs: 0, endMs: 5 }] } })]);
    const { queue, sent } = fakeQueue();

    const writeId = await startClipWriting({ db, queue, ownerId: "o1", clipIds: ["c2", "c1", "c2"] });

    expect(sent).toEqual([[writeId, ["c2", "c1"]]]);
    expect(state.clips.map((clip) => clip.aiWriteId)).toEqual([writeId, writeId]);
  });

  it("refuses without the script writer, with a link to install it", async () => {
    const { db } = fakeDb([clipRow("c1")], "not_installed");
    const error = await startClipWriting({ db, queue: fakeQueue().queue, ownerId: "o1", clipIds: ["c1"] }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UserError);
    expect((error as UserError).message).toContain("Script writer is not installed");
    expect((error as UserError).link?.href).toBe("/settings#slideshow-ai");
  });

  it("refuses a clip with no words, one being written and another owner's", async () => {
    const { queue, sent } = fakeQueue();
    const silent = fakeDb([clipRow("c1"), clipRow("c2", { words: null })]);
    await expect(startClipWriting({ db: silent.db, queue, ownerId: "o1", clipIds: ["c1", "c2"] })).rejects.toThrow(
      "c2 has no spoken words kept. Turn captions on and make clips again",
    );
    expect(silent.state.clips.map((clip) => clip.aiWriteId)).toEqual([null, null]);
    const busy = fakeDb([clipRow("c1", { aiWriteId: "w0" })]);
    await expect(startClipWriting({ db: busy.db, queue, ownerId: "o1", clipIds: ["c1"] })).rejects.toThrow("already being written");
    await expect(startClipWriting({ db: busy.db, queue, ownerId: "o2", clipIds: ["c1"] })).rejects.toThrow("clip not found");
    await expect(startClipWriting({ db: busy.db, queue, ownerId: "o1", clipIds: [] })).rejects.toThrow("at least one");
    expect(sent).toEqual([]);
  });

  it("records the error on the clips when the job cannot be queued", async () => {
    const { db, state } = fakeDb([clipRow("c1")]);
    await expect(startClipWriting({ db, queue: fakeQueue(true).queue, ownerId: "o1", clipIds: ["c1"] })).rejects.toThrow("pg-boss is down");
    expect(state.clips[0]).toMatchObject({ aiWriteId: null, aiWriteError: "pg-boss is down" });
  });
});

describe("runClipWriter with a fake llama-server", () => {
  let root: string;
  let record: string;
  let start: StartLlm;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "clip-writer-test-"));
    const fakes = await writeFakeEngines(root);
    record = path.join(root, "llama.jsonl");
    process.env.FAKE_LLAMA_RECORD = record;
    start = (signal) => startLlamaServer({ server: fakes.server, model: "/m/Qwen3.5-4B-Q4_K_M.gguf", logPath: path.join(root, "llama.log"), signal });
  });

  afterAll(async () => {
    delete process.env.FAKE_LLAMA_REPLY;
    delete process.env.FAKE_LLAMA_RECORD;
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    delete process.env.FAKE_LLAMA_REPLY;
    await writeFile(record, "");
  });

  const records = async () =>
    (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { request?: { messages: { content: string }[]; response_format: { schema: unknown } }; stopped?: true });

  // Runs the callback once the fake server has logged n requests.
  function whenRequested(n: number, then: () => void) {
    const poll = setInterval(async () => {
      if ((await records()).filter((entry) => entry.request).length < n) return;
      clearInterval(poll);
      then();
    }, 50);
  }

  it("writes one clip's suggestion from its words and stops the server", async () => {
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1" })]);

    await runClipWriter({ db, writeId: "w1", clipIds: ["c1"], startLlm: start, checkEveryMs: 50 });

    expect(state.clips[0]).toMatchObject({
      aiWriteId: null,
      aiWriteStep: null,
      aiWriteError: null,
      aiSuggestion: { title: "Title 1", description: "The first sentence. The second one.", hashtags: ["one", "two", "three"] },
    });
    expect(state.steps).toEqual(["c1: Starting the script writer", "c1: Waiting for the clips before it", "c1: Writing"]);
    const entries = await records();
    expect(entries).toHaveLength(2);
    expect(entries[0].request!.messages[1].content).toContain('"""Coffee beats tea"""');
    expect(entries[0].request!.messages[1].content).toContain('"Morning show"');
    expect(entries[0].request!.response_format.schema).toEqual(suggestionSchema());
    expect(entries[1]).toEqual({ stopped: true });
  });

  it("writes several clips in order on one start of the server, skipping one no longer in the job", async () => {
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1" }), clipRow("c2", { aiWriteId: null }), clipRow("c3", { aiWriteId: "w1" })]);

    await runClipWriter({ db, writeId: "w1", clipIds: ["c3", "c2", "c1"], startLlm: start, checkEveryMs: 50 });

    expect(state.clips.map((clip) => (clip.aiSuggestion as Row | null)?.title ?? null)).toEqual(["Title 2", null, "Title 1"]);
    const entries = await records();
    expect(entries.filter((entry) => entry.request)).toHaveLength(2);
    expect(entries.filter((entry) => entry.stopped)).toHaveLength(1);
  });

  it("records an answer that breaks the rules on its clip and goes on", async () => {
    process.env.FAKE_LLAMA_REPLY = JSON.stringify({ title: "x", description: "y.", hashtags: ["one"] });
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1" }), clipRow("c2", { aiWriteId: "w1" })]);

    await runClipWriter({ db, writeId: "w1", clipIds: ["c1", "c2"], startLlm: start, checkEveryMs: 50 });

    for (const clip of state.clips) {
      expect(clip).toMatchObject({ aiWriteId: null, aiSuggestion: null, aiWriteError: "the suggestion has 1 hashtags instead of 3 to 5" });
    }
    expect((await records()).filter((entry) => entry.request)).toHaveLength(2);
  });

  it("does nothing for a job whose clips were all cancelled before it ran", async () => {
    const { db, state } = fakeDb([clipRow("c1")]);
    await runClipWriter({ db, writeId: "w1", clipIds: ["c1"], startLlm: start, checkEveryMs: 50 });
    expect(state.steps).toEqual([]);
    expect(await records()).toEqual([]);
  });

  it("fails every clip when the script writer was removed", async () => {
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1" }), clipRow("c2", { aiWriteId: "w1" })], "not_installed");
    await expect(runClipWriter({ db, writeId: "w1", clipIds: ["c1", "c2"], startLlm: start, checkEveryMs: 50 })).rejects.toThrow("not installed");
    expect(state.clips.map((clip) => [clip.aiWriteId, clip.aiWriteError])).toEqual([
      [null, "the Script writer is not installed"],
      [null, "the Script writer is not installed"],
    ]);
  });

  it("stops the server when its only clip is cancelled while it is written", async () => {
    process.env.FAKE_LLAMA_REPLY = "slow";
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1" })]);
    const jobs = fakeJobs({ w1: ["job-1"] });
    whenRequested(1, () => void cancelClipWriting({ db, jobs: jobs.jobs, ownerId: "o1", clipId: "c1" }));

    await runClipWriter({ db, writeId: "w1", clipIds: ["c1"], startLlm: start, checkEveryMs: 50 });

    expect(state.clips[0]).toMatchObject({ aiWriteId: null, aiSuggestion: null, aiWriteError: null });
    expect((await records()).at(-1)).toEqual({ stopped: true });
    expect(jobs.cancelled).toEqual(["job-1"]);
  });

  it("goes on with the next clip when the one being written is cancelled", async () => {
    process.env.FAKE_LLAMA_REPLY = "slow-first";
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1" }), clipRow("c2", { aiWriteId: "w1" })]);
    const jobs = fakeJobs({ w1: ["job-1"] });
    whenRequested(1, () => void cancelClipWriting({ db, jobs: jobs.jobs, ownerId: "o1", clipId: "c1" }));

    await runClipWriter({ db, writeId: "w1", clipIds: ["c1", "c2"], startLlm: start, checkEveryMs: 50 });

    expect(state.clips[0]).toMatchObject({ aiWriteId: null, aiSuggestion: null, aiWriteError: null });
    expect(state.clips[1]).toMatchObject({ aiWriteId: null, aiSuggestion: { title: "Title 1" } });
    expect((await records()).filter((entry) => entry.stopped)).toHaveLength(1);
    // c2 was still in the job, so its pg-boss job stayed.
    expect(jobs.cancelled).toEqual([]);
  });
});

function fakeJobs(byWriteId: Record<string, string[]>, waiting: Record<string, string[]> = {}) {
  const cancelled: string[] = [];
  const jobs: StartupWorkJobs = {
    open: async (id) => byWriteId[id] ?? [],
    waiting: async (id) => waiting[id] ?? [],
    cancel: async (ids) => void cancelled.push(...ids),
  };
  return { jobs, cancelled };
}

describe("cancelClipWriting", () => {
  it("drops the clip from its job, and the job once no clip is left", async () => {
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1", aiWriteStep: "Writing" }), clipRow("c2", { aiWriteId: "w1" })]);
    const { jobs, cancelled } = fakeJobs({ w1: ["job-1"] });

    await cancelClipWriting({ db, jobs, ownerId: "o1", clipId: "c1" });
    expect(state.clips[0]).toMatchObject({ aiWriteId: null, aiWriteStep: null });
    expect(cancelled).toEqual([]);

    await cancelClipWriting({ db, jobs, ownerId: "o1", clipId: "c2" });
    expect(cancelled).toEqual(["job-1"]);
  });

  it("refuses another owner's clip and a clip that is not being written", async () => {
    const { db } = fakeDb([clipRow("c1", { aiWriteId: "w1" }), clipRow("c2")]);
    const { jobs } = fakeJobs({});
    await expect(cancelClipWriting({ db, jobs, ownerId: "o2", clipId: "c1" })).rejects.toThrow("clip not found");
    await expect(cancelClipWriting({ db, jobs, ownerId: "o1", clipId: "c2" })).rejects.toThrow("not being written");
  });
});

describe("failInterruptedWrites", () => {
  it("fails the clips of a job no longer waiting, and keeps those of one that is", async () => {
    const { db, state } = fakeDb([clipRow("c1", { aiWriteId: "w1", aiWriteStep: "Writing" }), clipRow("c2", { aiWriteId: "w2" })]);
    const { jobs, cancelled } = fakeJobs({ w1: ["job-1"], w2: ["job-2"] }, { w2: ["job-2"] });

    expect(await failInterruptedWrites({ db, jobs })).toEqual(["w1"]);

    expect(state.clips[0]).toMatchObject({ aiWriteId: null, aiWriteStep: null, aiWriteError: WRITE_CLOSED_ERROR });
    expect(state.clips[1]).toMatchObject({ aiWriteId: "w2" });
    expect(cancelled).toEqual(["job-1"]);
  });
});

describe("applySuggestions", () => {
  const suggestion = { title: "Why coffee wins", description: "Coffee beats tea.", hashtags: ["coffee", "tea", "morning"] };

  it("fills in the title and the description with its hashtags, and clears the suggestion", async () => {
    const { db, state } = fakeDb([
      clipRow("c1", { title: "Old", description: "Old text", aiSuggestion: suggestion }),
      clipRow("c2", { aiSuggestion: { ...suggestion, title: "Second" } }),
    ]);

    expect(await applySuggestions({ db, ownerId: "o1", clipIds: ["c1", "c2"] })).toBe(2);

    expect(state.clips[0]).toMatchObject({
      title: "Why coffee wins",
      description: "Coffee beats tea.\n\n#coffee #tea #morning",
      aiSuggestion: null,
    });
    expect(state.clips[1]).toMatchObject({ title: "Second", aiSuggestion: null });
    expect(suggestedDescription(suggestion)).toBe("Coffee beats tea.\n\n#coffee #tea #morning");
  });

  it("changes nothing when any clip has no suggestion or one beyond the limits", async () => {
    const { db, state } = fakeDb([
      clipRow("c1", { title: "Old", aiSuggestion: suggestion }),
      clipRow("c2", { aiSuggestion: null }),
      clipRow("c3", { aiSuggestion: { ...suggestion, hashtags: ["a1", "b2", "c3", "d4", "e5", "f6"] } }),
      clipRow("c4", { aiSuggestion: { ...suggestion, title: "x".repeat(61) } }),
    ]);

    await expect(applySuggestions({ db, ownerId: "o1", clipIds: ["c1", "c2"] })).rejects.toThrow("c2 has no suggestion");
    await expect(applySuggestions({ db, ownerId: "o1", clipIds: ["c1", "c3"] })).rejects.toThrow("6 hashtags");
    await expect(applySuggestions({ db, ownerId: "o1", clipIds: ["c1", "c4"] })).rejects.toThrow("title");
    await expect(applySuggestions({ db, ownerId: "o2", clipIds: ["c1"] })).rejects.toThrow("clip not found");
    expect(state.clips[0]).toMatchObject({ title: "Old", aiSuggestion: suggestion });
  });

  it("checks a stored suggestion as strictly as an answer", () => {
    expect(() => parseSuggestion({ ...suggestion, description: "Has #tag." })).toThrow("hashtag in it");
  });
});
