import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireEnv } from "./env";

const UPLOAD_LIFETIME_SECONDS = 7200;

function client(): S3Client {
  return new S3Client({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: "us-east-1",
    forcePathStyle: true,
    // Presigned uploads would otherwise carry a CRC32 of an empty body, which servers that check it reject.
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: requireEnv("S3_ACCESS_KEY"),
      secretAccessKey: requireEnv("S3_SECRET_KEY"),
    },
  });
}

export function buildRawKey(id: string, extension: string): string {
  return `raw/${id}${extension.toLowerCase()}`;
}

export function buildReelKey(id: string): string {
  return `reels/${id}.mp4`;
}

// A YouTube post's own copy of its clip.
export function buildYouTubeKey(postId: string): string {
  return `youtube/${postId}.mp4`;
}

// A Facebook post's and a TikTok post's own copies of their clips.
export function buildFacebookKey(postId: string): string {
  return `facebook/${postId}.mp4`;
}

export function buildTikTokKey(postId: string): string {
  return `tiktok/${postId}.mp4`;
}

export function buildClipSourceKey(projectId: string, extension: string): string {
  return `clip-sources/${projectId}${extension.toLowerCase()}`;
}

export function buildClipKey(projectId: string, clipId: string): string {
  return `clips/${projectId}/${clipId}.mp4`;
}

// A re-rendered clip's file: each version has its own key, so the one being replaced stays until the new one is saved.
export function buildClipVersionKey(projectId: string, clipId: string, version: number): string {
  if (!Number.isInteger(version) || version < 2) throw new Error(`clip version ${version} is not a re-render`);
  return `clips/${projectId}/${clipId}.v${version}.mp4`;
}

// A captioned clip's cut without captions, for drawing its captions again.
export function buildClipBaseKey(projectId: string, clipId: string): string {
  return `clips/${projectId}/${clipId}.base.mp4`;
}

// The start picture of an AI video, uploaded from the Clips page.
export function buildAiInputKey(id: string, extension: string): string {
  return `ai-inputs/${id}${extension.toLowerCase()}`;
}

// A photo for a slideshow slide, uploaded from the Clips page.
export function buildSlideshowInputKey(id: string, extension: string): string {
  return `slideshow-inputs/${id}${extension.toLowerCase()}`;
}

export async function presignUpload(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: requireEnv("S3_BUCKET"), Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_LIFETIME_SECONDS },
  );
}

export async function presignDownload(key: string, expiresInSeconds: number): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: requireEnv("S3_BUCKET"), Key: key }), {
    expiresIn: expiresInSeconds,
  });
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: requireEnv("S3_BUCKET"), Key: key }));
}

// Server-side copy, so the bytes never pass through this process.
export async function copyObject(from: string, to: string): Promise<void> {
  const bucket = requireEnv("S3_BUCKET");
  const source = `${bucket}/${from.split("/").map(encodeURIComponent).join("/")}`;
  await client().send(new CopyObjectCommand({ Bucket: bucket, CopySource: source, Key: to }));
}

export async function downloadToFile(key: string, filePath: string): Promise<void> {
  const response = await client().send(new GetObjectCommand({ Bucket: requireEnv("S3_BUCKET"), Key: key }));
  if (!response.Body) throw new Error(`${key} has no content`);
  await pipeline(response.Body as Readable, createWriteStream(filePath));
}

export async function uploadFromFile(key: string, filePath: string, contentType: string): Promise<void> {
  const { size } = await stat(filePath);
  await client().send(
    new PutObjectCommand({
      Bucket: requireEnv("S3_BUCKET"),
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
    }),
  );
}

// Streams an object out of storage, with its size, for a copy to somewhere else.
export async function openObject(key: string): Promise<{ body: Readable; size: number }> {
  const response = await client().send(new GetObjectCommand({ Bucket: requireEnv("S3_BUCKET"), Key: key }));
  if (!response.Body || response.ContentLength === undefined) throw new Error(`${key} has no content`);
  return { body: response.Body as Readable, size: response.ContentLength };
}

export async function objectSize(key: string): Promise<number> {
  const response = await client().send(new HeadObjectCommand({ Bucket: requireEnv("S3_BUCKET"), Key: key }));
  if (response.ContentLength === undefined) throw new Error(`${key} has no size`);
  return response.ContentLength;
}

// Bytes start to end (inclusive) of an object, for sending a large file in chunks without holding all of it.
export async function readObjectRange(key: string, start: number, end: number): Promise<Uint8Array> {
  const response = await client().send(
    new GetObjectCommand({ Bucket: requireEnv("S3_BUCKET"), Key: key, Range: `bytes=${start}-${end}` }),
  );
  if (!response.Body) throw new Error(`${key} has no content`);
  const bytes = await response.Body.transformToByteArray();
  if (bytes.byteLength !== end - start + 1) throw new Error(`${key}: read ${bytes.byteLength} bytes, expected ${end - start + 1}`);
  return bytes;
}

export type StoredObject = { key: string; size: number; lastModified: Date };

// Every object in the bucket, a page of up to 1000 at a time.
export async function* listObjects(): AsyncGenerator<StoredObject> {
  const bucket = requireEnv("S3_BUCKET");
  let token: string | undefined;
  do {
    const page = await client().send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const item of page.Contents ?? []) {
      if (item.Key === undefined || item.Size === undefined || item.LastModified === undefined) {
        throw new Error(`the storage listing has an object without its key, size or date: ${JSON.stringify(item)}`);
      }
      yield { key: item.Key, size: item.Size, lastModified: item.LastModified };
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}
