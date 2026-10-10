import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireEnv } from "./env";

const UPLOAD_LIFETIME_SECONDS = 7200;

function client(): S3Client {
  return new S3Client({
    endpoint: requireEnv("S3_ENDPOINT"),
    region: "us-east-1",
    forcePathStyle: true,
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
