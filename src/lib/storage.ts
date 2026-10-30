import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
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

export function buildClipSourceKey(projectId: string, extension: string): string {
  return `clip-sources/${projectId}${extension.toLowerCase()}`;
}

export function buildClipKey(projectId: string, clipId: string): string {
  return `clips/${projectId}/${clipId}.mp4`;
}

// The start picture of an AI video, uploaded from the Clips page.
export function buildAiInputKey(id: string, extension: string): string {
  return `ai-inputs/${id}${extension.toLowerCase()}`;
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
