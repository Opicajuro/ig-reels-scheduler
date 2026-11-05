import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { parseUploadTitle } from "@/clip-engine/helpers.js";
import { validateCaption } from "./caption";
import { parseClipWords } from "./caption-words";
import { parseTranscript, wordsInRange } from "./highlights";
import { askLlm, type StartLlm } from "./llm-script";
import { withCredit } from "./music-library";
import type { StartupWorkJobs } from "./queues";
import { getSlideshowEngine } from "./slideshow-engines";
import { UserError } from "./user-error";

// "Write with AI" on a clip: the script writer (llama-server, as for slideshows) reads what is said in the clip and
// suggests a title, a short description and a few hashtags. The suggestion is kept on the clip until the person uses
// or discards it: it never replaces the clip's title or description by itself. Several clips are written by one job,
// one after another, on one start of the server.

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 300;
export const SENTENCES_MAX = 3;
export const HASHTAGS_MIN = 3;
export const HASHTAGS_MAX = 5;
// Instagram shows at most 5 hashtags on a caption.
export const CAPTION_HASHTAGS_MAX = 5;
const CAPTION_MAX = 2200;
const HASHTAG_PATTERN = "^[a-z0-9_]{2,30}$";
// What is said is cut to this many characters, well inside the server's 8192-token context.
export const SPOKEN_MAX = 6000;
export const MAX_WRITE_CLIPS = 50;

const CANCEL_CHECK_MS = 2000;
export const WRITE_CLOSED_ERROR = "Stopped because Localirs was closed. Write it again.";

export type ClipSuggestion = { title: string; description: string; hashtags: string[] };

export type ClipWriterQueue = {
  send(writeId: string, clipIds: string[]): Promise<string>;
};

export const SCRIPT_WRITER_LINK = { href: "/settings#slideshow-ai", label: "Install the Script writer in Settings" };

export function suggestionSchema() {
  return {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: TITLE_MAX },
      description: { type: "string", minLength: 1, maxLength: DESCRIPTION_MAX },
      hashtags: {
        type: "array",
        minItems: HASHTAGS_MIN,
        maxItems: HASHTAGS_MAX,
        items: { type: "string", pattern: HASHTAG_PATTERN },
      },
    },
    required: ["title", "description", "hashtags"],
    additionalProperties: false,
  };
}

export function suggestionPrompt(projectName: string, spoken: string): string {
  return [
    `A short vertical video clip from the video "${projectName}". What is said in it:`,
    `"""${spoken}"""`,
    `Write, in English, a "title" of at most ${TITLE_MAX} characters that makes people want to watch, a "description"`,
    `of 1 to ${SENTENCES_MAX} short sentences about the clip, without hashtags or emoji, and ${HASHTAGS_MIN} to ${HASHTAGS_MAX}`,
    `"hashtags" that fit it: lowercase, no spaces and no # sign.`,
  ].join("\n");
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((part) => part.trim()).length;
}

// The model's answer or a stored suggestion, checked against the rules it was given: a title of at most 60
// characters, 1 to 3 sentences of description without hashtags, and 3 to 5 different lowercase hashtags.
export function parseSuggestion(value: unknown): ClipSuggestion {
  const { title, description, hashtags } = (value ?? {}) as Record<string, unknown>;
  if (typeof title !== "string" || typeof description !== "string" || !Array.isArray(hashtags)) {
    throw new Error("the suggestion lacks its title, description or hashtags");
  }
  const heading = title.trim();
  const text = description.trim();
  if (!heading || heading.length > TITLE_MAX) throw new Error(`the suggested title is not 1 to ${TITLE_MAX} characters`);
  if (!text || text.length > DESCRIPTION_MAX) throw new Error(`the suggested description is not 1 to ${DESCRIPTION_MAX} characters`);
  if (sentenceCount(text) > SENTENCES_MAX) throw new Error(`the suggested description is longer than ${SENTENCES_MAX} sentences`);
  if (text.includes("#")) throw new Error("the suggested description has a hashtag in it");
  if (hashtags.length < HASHTAGS_MIN || hashtags.length > HASHTAGS_MAX) {
    throw new Error(`the suggestion has ${hashtags.length} hashtags instead of ${HASHTAGS_MIN} to ${HASHTAGS_MAX}`);
  }
  const tags = hashtags.map((tag: unknown) => {
    if (typeof tag !== "string" || !new RegExp(HASHTAG_PATTERN).test(tag)) {
      throw new Error(`the suggested hashtag "${String(tag)}" is not lowercase letters and digits`);
    }
    return tag;
  });
  if (new Set(tags).size !== tags.length) throw new Error("the suggestion repeats a hashtag");
  return { title: heading, description: text, hashtags: tags };
}

export function parseSuggestionAnswer(content: string): ClipSuggestion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`the script writer's answer is not JSON: ${content.slice(0, 200)}`);
  }
  return parseSuggestion(parsed);
}

export async function requestSuggestion({
  url,
  projectName,
  spoken,
  signal,
}: {
  url: string;
  projectName: string;
  spoken: string;
  signal: AbortSignal;
}): Promise<ClipSuggestion> {
  const content = await askLlm({
    url,
    system: "You write titles and captions for short vertical videos on Instagram and YouTube.",
    prompt: suggestionPrompt(projectName, spoken),
    schema: suggestionSchema(),
    temperature: 0.7,
    signal,
  });
  return parseSuggestionAnswer(content);
}

// What is said in a clip: its own caption words, or the project's transcript over the clip's stretch of the video.
// Empty when neither was kept.
export function spokenWords(clip: { words: unknown; start: number; length: number }, transcript: unknown): string {
  const text =
    clip.words !== null
      ? parseClipWords(clip.words)
          .map((word) => word.text)
          .join(" ")
      : transcript !== null
        ? wordsInRange(parseTranscript(transcript), clip)
        : "";
  const spoken = text.replace(/\s+/g, " ").trim();
  return spoken.length > SPOKEN_MAX ? spoken.slice(0, spoken.lastIndexOf(" ", SPOKEN_MAX)) : spoken;
}

const NO_WORDS = "has no spoken words kept. Turn captions on and make clips again, then write with AI.";

// Queues one job writing the clips' suggestions in the order given. A clip already being written, one with nothing
// said in it and a missing script writer are refused before anything is queued.
export async function startClipWriting({
  db,
  queue,
  ownerId,
  clipIds,
}: {
  db: PrismaClient;
  queue: ClipWriterQueue;
  ownerId: string;
  clipIds: string[];
}): Promise<string> {
  const ids = [...new Set(clipIds)];
  if (ids.length === 0) throw new UserError("pick at least one clip");
  if (ids.length > MAX_WRITE_CLIPS) throw new UserError(`write at most ${MAX_WRITE_CLIPS} clips at a time`);
  if ((await getSlideshowEngine(db, "script")).status !== "installed") {
    throw new UserError("the Script writer is not installed", SCRIPT_WRITER_LINK);
  }
  const clips = await db.clip.findMany({
    where: { id: { in: ids }, project: { ownerId } },
    select: { id: true, name: true, words: true, start: true, length: true, aiWriteId: true, project: { select: { transcript: true } } },
  });
  if (clips.length !== ids.length) throw new UserError("clip not found");
  for (const clip of clips) {
    if (clip.aiWriteId) throw new UserError(`${clip.name} is already being written`);
    if (!spokenWords(clip, clip.project.transcript)) throw new UserError(`${clip.name} ${NO_WORDS}`);
  }

  const writeId = randomUUID();
  const { count } = await db.clip.updateMany({
    where: { id: { in: ids }, aiWriteId: null },
    data: { aiWriteId: writeId, aiWriteStep: null, aiWriteError: null },
  });
  const undo = (error: string | null) => db.clip.updateMany({ where: { aiWriteId: writeId }, data: { aiWriteId: null, aiWriteError: error } });
  if (count !== ids.length) {
    await undo(null);
    throw new UserError("one of these clips is already being written");
  }
  try {
    await queue.send(writeId, ids);
  } catch (err) {
    await undo(err instanceof Error ? err.message : String(err));
    throw err;
  }
  return writeId;
}

// Thrown into a request whose clip was cancelled, to go on with the next clip.
class ClipCancelled extends Error {}
// Thrown into the job once all its clips were cancelled, to stop the server.
class WriteCancelled extends Error {}

// Writes the suggestions of one job's clips. A clip is still the job's while it carries writeId: cancelling it, deleting
// it or making clips again drops it, its request is aborted within checkEveryMs, and the job goes on with the next.
// Once none is left the server is stopped. A clip whose answer breaks the rules gets the error and the job goes on;
// a server that does not start fails every clip.
export async function runClipWriter({
  db,
  writeId,
  clipIds,
  startLlm,
  checkEveryMs = CANCEL_CHECK_MS,
}: {
  db: PrismaClient;
  writeId: string;
  clipIds: string[];
  startLlm: StartLlm;
  checkEveryMs?: number;
}) {
  const mine = async () =>
    (await db.clip.findMany({ where: { aiWriteId: writeId }, select: { id: true } })).map((clip) => clip.id);
  // Cancelled before the worker took it.
  if ((await mine()).length === 0) return;
  const write = (where: { id?: string }, data: Prisma.ClipUncheckedUpdateManyInput) =>
    db.clip.updateMany({ where: { ...where, aiWriteId: writeId }, data });

  const controller = new AbortController();
  const { signal } = controller;
  let current: { id: string; controller: AbortController } | null = null;
  const check = setInterval(() => {
    mine().then(
      (left) => {
        if (left.length === 0) controller.abort(new WriteCancelled());
        else if (current && !left.includes(current.id)) current.controller.abort(new ClipCancelled());
      },
      (err: unknown) => controller.abort(err),
    );
  }, checkEveryMs);

  try {
    let llm;
    try {
      if ((await getSlideshowEngine(db, "script")).status !== "installed") throw new Error("the Script writer is not installed");
      await write({}, { aiWriteStep: "Starting the script writer" });
      llm = await startLlm(signal);
      await write({}, { aiWriteStep: "Waiting for the clips before it" });
    } catch (err) {
      if (signal.reason instanceof WriteCancelled) return;
      const failure = signal.aborted ? signal.reason : err;
      await write({}, { aiWriteId: null, aiWriteStep: null, aiWriteError: failure instanceof Error ? failure.message : String(failure) });
      throw failure;
    }
    try {
      for (const clipId of clipIds) {
        if (signal.aborted) {
          if (signal.reason instanceof WriteCancelled) break;
          throw signal.reason;
        }
        const clip = await db.clip.findUnique({
          where: { id: clipId },
          select: { aiWriteId: true, words: true, start: true, length: true, project: { select: { name: true, transcript: true } } },
        });
        if (clip?.aiWriteId !== writeId) continue;
        current = { id: clipId, controller: new AbortController() };
        try {
          await write({ id: clipId }, { aiWriteStep: "Writing" });
          const suggestion = await requestSuggestion({
            url: llm.url,
            projectName: clip.project.name,
            spoken: spokenWords(clip, clip.project.transcript),
            signal: AbortSignal.any([signal, current.controller.signal]),
          });
          await write({ id: clipId }, { aiWriteId: null, aiWriteStep: null, aiWriteError: null, aiSuggestion: suggestion });
        } catch (err) {
          if (signal.reason instanceof WriteCancelled || current.controller.signal.reason instanceof ClipCancelled) continue;
          if (signal.aborted) throw signal.reason;
          await write({ id: clipId }, { aiWriteId: null, aiWriteStep: null, aiWriteError: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      await write({}, { aiWriteId: null, aiWriteStep: null, aiWriteError: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      await llm.stop();
    }
  } finally {
    clearInterval(check);
  }
}

// Stops writing one clip: it no longer carries the job's id, so the job skips it or aborts its request. The job's
// pg-boss job is dropped once none of its clips is left.
export async function cancelClipWriting({
  db,
  jobs,
  ownerId,
  clipId,
}: {
  db: PrismaClient;
  jobs: StartupWorkJobs;
  ownerId: string;
  clipId: string;
}) {
  const clip = await db.clip.findFirst({ where: { id: clipId, project: { ownerId } }, select: { aiWriteId: true } });
  if (!clip) throw new UserError("clip not found");
  if (!clip.aiWriteId) throw new UserError("this clip is not being written");
  const { count } = await db.clip.updateMany({
    where: { id: clipId, aiWriteId: clip.aiWriteId },
    data: { aiWriteId: null, aiWriteStep: null },
  });
  if (count === 0) throw new UserError("the writing finished before it could be cancelled");
  if ((await db.clip.count({ where: { aiWriteId: clip.aiWriteId } })) > 0) return;
  const open = await jobs.open(clip.aiWriteId);
  if (open.length > 0) await jobs.cancel(open);
}

// Run once when the worker starts, before it takes writing jobs. A clip still being written then, with no job waiting
// to write it, was cut off by closing Localirs: it gets the error and can be written again.
export async function failInterruptedWrites({ db, jobs }: { db: PrismaClient; jobs: StartupWorkJobs }): Promise<string[]> {
  const clips = await db.clip.findMany({ where: { aiWriteId: { not: null } }, select: { aiWriteId: true } });
  const failed: string[] = [];
  for (const writeId of new Set(clips.map((clip) => clip.aiWriteId!))) {
    if ((await jobs.waiting(writeId)).length > 0) continue;
    const open = await jobs.open(writeId);
    if (open.length > 0) await jobs.cancel(open);
    await db.clip.updateMany({ where: { aiWriteId: writeId }, data: { aiWriteId: null, aiWriteStep: null, aiWriteError: WRITE_CLOSED_ERROR } });
    failed.push(writeId);
  }
  return failed;
}

// The description a suggestion fills in: its sentences, then its hashtags.
export function suggestedDescription(suggestion: ClipSuggestion): string {
  return `${suggestion.description}\n\n${suggestion.hashtags.map((tag) => `#${tag}`).join(" ")}`;
}

// "Use" or "Use all": each clip's stored suggestion becomes its title and description, and is cleared. Every clip is
// checked before any is changed: its caption, with its music's credit line, must stay within Instagram's 2,200
// characters and 5 hashtags.
export async function applySuggestions({ db, ownerId, clipIds }: { db: PrismaClient; ownerId: string; clipIds: string[] }): Promise<number> {
  const ids = [...new Set(clipIds)];
  if (ids.length === 0) throw new UserError("pick at least one clip");
  const clips = await db.clip.findMany({
    where: { id: { in: ids }, project: { ownerId } },
    select: { id: true, name: true, musicTrack: true, aiSuggestion: true },
  });
  if (clips.length !== ids.length) throw new UserError("clip not found");
  const updates = clips.map((clip) => {
    if (clip.aiSuggestion === null) throw new UserError(`${clip.name} has no suggestion to use`);
    const suggestion = parseSuggestion(clip.aiSuggestion);
    const title = parseUploadTitle(suggestion.title);
    const description = suggestedDescription(suggestion);
    const caption = withCredit(description, clip.musicTrack);
    if (caption.length > CAPTION_MAX) throw new UserError(`${clip.name}'s caption would be longer than ${CAPTION_MAX} characters`);
    if ((caption.match(/#\w+/g) ?? []).length > CAPTION_HASHTAGS_MAX) {
      throw new UserError(`${clip.name}'s caption would have more than ${CAPTION_HASHTAGS_MAX} hashtags`);
    }
    const problems = validateCaption(caption);
    if (problems.length > 0) throw new UserError(`${clip.name}: ${problems.join(", ")}`);
    return { id: clip.id, title, description };
  });
  await db.$transaction(
    updates.map((update) =>
      db.clip.update({ where: { id: update.id }, data: { title: update.title, description: update.description, aiSuggestion: Prisma.DbNull } }),
    ),
  );
  return updates.length;
}

export async function discardSuggestion({ db, ownerId, clipId }: { db: PrismaClient; ownerId: string; clipId: string }) {
  const { count } = await db.clip.updateMany({
    where: { id: clipId, project: { ownerId } },
    data: { aiSuggestion: Prisma.DbNull, aiWriteError: null },
  });
  if (count === 0) throw new UserError("clip not found");
}
