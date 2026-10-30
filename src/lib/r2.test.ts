import { Readable } from "node:stream";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { discardIgPostVideo, R2NotSetUp, stageIgPostVideo, testR2Connection } from "./r2";
import { sealSecret, type R2Config } from "./settings";

const KEY = Buffer.alloc(32, 7);
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const CONFIG: R2Config = { accountId: ACCOUNT_ID, accessKeyId: "key-id", secretAccessKey: "r2-secret", bucket: "localirs-ig" };

// An in-memory bucket that answers the commands the module sends, as R2 would.
let bucket: Map<string, string>;
let sent: Array<{ command: string; bucket: string; key: string; endpoint: string }>;
let failWith: Error | null;

async function readBody(body: unknown): Promise<string> {
  if (typeof body === "string") return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = KEY.toString("base64");
  bucket = new Map();
  sent = [];
  failWith = null;
  vi.spyOn(S3Client.prototype, "send").mockImplementation(async function (this: S3Client, command: unknown) {
    const endpoint = await this.config.endpoint!();
    const input = (command as { input: { Bucket: string; Key: string; Body?: unknown } }).input;
    sent.push({ command: (command as object).constructor.name, bucket: input.Bucket, key: input.Key, endpoint: endpoint.hostname });
    if (failWith) throw failWith;
    if (command instanceof PutObjectCommand) bucket.set(input.Key, await readBody(input.Body));
    else if (command instanceof DeleteObjectCommand) bucket.delete(input.Key);
    else throw new Error(`unexpected command ${(command as object).constructor.name}`);
    return {};
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TOKEN_ENC_KEY;
});

function fakeDb(r2: R2Config | null) {
  const row = r2
    ? {
        r2AccountId: r2.accountId,
        r2AccessKeyId: r2.accessKeyId,
        r2SecretAccessKey: sealSecret(r2.secretAccessKey, KEY),
        r2Bucket: r2.bucket,
        metaAppSecret: null,
        resendApiKey: null,
      }
    : null;
  return { setting: { findUnique: async () => row } } as unknown as PrismaClient;
}

const openReel = async (key: string) => ({ body: Readable.from([Buffer.from(`video of ${key}`)]), size: 99 });

describe("stageIgPostVideo", () => {
  it("streams the Reel from local storage to ig-posts/<postId>.mp4 in the R2 bucket and returns a one-hour link to it", async () => {
    const link = new URL(await stageIgPostVideo(fakeDb(CONFIG), openReel, "post-1", "reels/media-1.mp4"));

    expect(sent).toEqual([
      { command: "PutObjectCommand", bucket: "localirs-ig", key: "ig-posts/post-1.mp4", endpoint: `${ACCOUNT_ID}.r2.cloudflarestorage.com` },
    ]);
    expect(bucket.get("ig-posts/post-1.mp4")).toBe("video of reels/media-1.mp4");
    expect(link.origin).toBe(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(link.pathname).toBe("/localirs-ig/ig-posts/post-1.mp4");
    expect(link.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(link.searchParams.get("X-Amz-Credential")).toContain("key-id/");
    expect(link.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/");
  });

  it("uploads again on a retry after the copy was deleted", async () => {
    const db = fakeDb(CONFIG);
    await stageIgPostVideo(db, openReel, "post-1", "reels/media-1.mp4");
    await discardIgPostVideo(db, "post-1");
    expect(bucket.size).toBe(0);

    await stageIgPostVideo(db, openReel, "post-1", "reels/media-1.mp4");
    expect(bucket.has("ig-posts/post-1.mp4")).toBe(true);
  });

  it("throws R2NotSetUp, without touching storage, when R2 is not saved", async () => {
    let opened = false;
    const open = async (key: string) => {
      opened = true;
      return openReel(key);
    };
    await expect(stageIgPostVideo(fakeDb(null), open, "post-1", "reels/media-1.mp4")).rejects.toBeInstanceOf(R2NotSetUp);
    expect(opened).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("discardIgPostVideo", () => {
  it("deletes the post's copy from the bucket", async () => {
    bucket.set("ig-posts/post-1.mp4", "video");
    await discardIgPostVideo(fakeDb(CONFIG), "post-1");
    expect(sent.map((s) => [s.command, s.key])).toEqual([["DeleteObjectCommand", "ig-posts/post-1.mp4"]]);
    expect(bucket.size).toBe(0);
  });

  it("does nothing when R2 is not saved, since nothing was uploaded", async () => {
    await discardIgPostVideo(fakeDb(null), "post-1");
    expect(sent).toEqual([]);
  });

  it("logs a failed delete instead of throwing, so the post's own outcome stands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failWith = new Error("network down");
    await expect(discardIgPostVideo(fakeDb(CONFIG), "post-1")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("could not delete ig-posts/post-1.mp4 from R2: network down");
  });
});

describe("testR2Connection", () => {
  // Answers the presigned link from the in-memory bucket, as R2 would.
  const fetchFromBucket = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    const key = decodeURIComponent(url.pathname.replace("/localirs-ig/", ""));
    const body = bucket.get(key);
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  }) as typeof fetch;

  it("uploads a test file, downloads it through a link, and deletes it", async () => {
    await testR2Connection(CONFIG, fetchFromBucket);
    expect(sent.map((s) => s.command)).toEqual(["PutObjectCommand", "DeleteObjectCommand"]);
    expect(sent[0].key).toMatch(/^localirs-test\/.+\.txt$/);
    expect(bucket.size).toBe(0);
  });

  it("says when the link does not work", async () => {
    const forbidden = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(testR2Connection(CONFIG, forbidden)).rejects.toThrow(
      "R2 test failed: the test file uploaded, but its link returned HTTP 403.",
    );
  });

  it.each([
    ["InvalidAccessKeyId", "R2 test failed: R2 does not know this access key ID. Copy it again from the API token."],
    ["SignatureDoesNotMatch", "R2 test failed: R2 refused the secret access key. Copy it again from the API token."],
    ["NoSuchBucket", "R2 test failed: this Cloudflare account has no R2 bucket named localirs-ig."],
    ["AccessDenied", "R2 test failed: the API token may not use the bucket localirs-ig. Give it Object Read & Write on it."],
  ])("puts R2's %s error in plain words", async (name, message) => {
    failWith = Object.assign(new Error("raw"), { name });
    await expect(testR2Connection(CONFIG, fetchFromBucket)).rejects.toThrow(message);
  });

  it("says R2 could not be reached when the account's address does not resolve", async () => {
    failWith = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    await expect(testR2Connection(CONFIG, fetchFromBucket)).rejects.toThrow(
      "R2 test failed: R2 could not be reached. Check the account ID and this PC's internet connection.",
    );
  });

  it("passes on the first line of an unreadable answer, with its HTTP status", async () => {
    failWith = Object.assign(new Error("XML parse error: unexpected content.\n  Deserialization error: details"), {
      $metadata: { httpStatusCode: 403 },
    });
    await expect(testR2Connection(CONFIG, fetchFromBucket)).rejects.toThrow(
      /^R2 test failed: R2 said \(HTTP 403\): XML parse error: unexpected content\.$/,
    );
  });

  it("passes on any other R2 message", async () => {
    failWith = new Error("Please try again later");
    await expect(testR2Connection(CONFIG, fetchFromBucket)).rejects.toThrow("R2 test failed: R2 said: Please try again later");
  });
});
