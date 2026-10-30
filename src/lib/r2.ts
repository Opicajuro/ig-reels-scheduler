import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { PrismaClient } from "@/generated/prisma/client";
import { getSettings, r2Settings, type R2Config } from "./settings";
import { UserError } from "./user-error";

// Instagram downloads a Reel from a link it is given, and the videos are only on this PC. So just before Instagram is
// asked to make the Reel, the video is copied to the user's Cloudflare R2 bucket and Instagram gets a link to it there.

export const R2_NOT_SET_UP = "Instagram posting needs Cloudflare R2 — set it up in Settings";
const LINK_SECONDS = 3600;

export class R2NotSetUp extends Error {
  constructor() {
    super(R2_NOT_SET_UP);
  }
}

export function r2Client(config: R2Config): S3Client {
  return new S3Client({
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    // <account>.r2.cloudflarestorage.com/<bucket>/<key>, under the one host name R2's certificate is sure to cover.
    forcePathStyle: true,
    // Only the checksums S3 requires, so uploads and links stay within what R2 accepts.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

export function igPostKey(postId: string): string {
  return `ig-posts/${postId}.mp4`;
}

// Where the Reel is read from: local storage's openObject in the app.
export type OpenReel = (key: string) => Promise<{ body: Readable; size: number }>;

// Settings are read on every use, so a save on /settings applies to the worker at once.
async function loadR2(db: PrismaClient): Promise<R2Config | null> {
  return r2Settings(await getSettings(db));
}

// Uploads the post's Reel to R2, replacing any earlier copy, and returns a link to it that works for an hour.
export async function stageIgPostVideo(db: PrismaClient, open: OpenReel, postId: string, reelKey: string): Promise<string> {
  const config = await loadR2(db);
  if (!config) throw new R2NotSetUp();
  const client = r2Client(config);
  const key = igPostKey(postId);
  const { body, size } = await open(reelKey);
  await client.send(
    new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentLength: size, ContentType: "video/mp4" }),
  );
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: LINK_SECONDS });
}

// Deletes the post's copy in R2 once the post is published, failed for good or canceled. The post's own outcome does not
// depend on it, so a failed delete is logged rather than thrown. Deleting a copy that is not there is not an error.
export async function discardIgPostVideo(db: PrismaClient, postId: string): Promise<void> {
  try {
    const config = await loadR2(db);
    if (!config) return;
    await r2Client(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: igPostKey(postId) }));
  } catch (err) {
    console.warn(`could not delete ${igPostKey(postId)} from R2: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// The R2 error in words a person can act on.
function describeR2Error(err: unknown, config: R2Config): string {
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: string }).code;
  if (name === "InvalidAccessKeyId") return "R2 does not know this access key ID. Copy it again from the API token.";
  if (name === "SignatureDoesNotMatch") return "R2 refused the secret access key. Copy it again from the API token.";
  if (name === "NoSuchBucket") return `this Cloudflare account has no R2 bucket named ${config.bucket}.`;
  if (name === "AccessDenied") return `the API token may not use the bucket ${config.bucket}. Give it Object Read & Write on it.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "R2 could not be reached. Check the account ID and this PC's internet connection.";
  }
  // Anything else: R2's own first line, with the HTTP status when there was one.
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
  return status ? `R2 said (HTTP ${status}): ${message}` : `R2 said: ${message}`;
}

// The same steps a post takes, with a small text file: upload, download through a link, delete.
export async function testR2Connection(config: R2Config, fetchFn: typeof fetch = fetch): Promise<void> {
  const client = r2Client(config);
  const key = `localirs-test/${randomUUID()}.txt`;
  const text = "Localirs connection test";
  try {
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: text, ContentType: "text/plain" }));
    const link = await getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: 60 });
    const response = await fetchFn(link);
    if (!response.ok) throw new UserError(`the test file uploaded, but its link returned HTTP ${response.status}.`);
    if ((await response.text()) !== text) throw new UserError("the test file uploaded, but its link returned something else.");
    await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (err) {
    if (err instanceof UserError) throw new UserError(`R2 test failed: ${err.message}`);
    throw new UserError(`R2 test failed: ${describeR2Error(err, config)}`);
  }
}
