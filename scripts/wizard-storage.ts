import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

type Send = (command: CreateBucketCommand) => Promise<unknown>;

// Same settings as src/lib/storage.ts, so the bucket is created where the app looks for it.
export function storageClient(endpoint: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

// Running the wizard twice must not fail, so an existing bucket that we own counts as done.
export async function ensureBucket(send: Send, bucket: string): Promise<void> {
  try {
    await send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err) {
    if (err instanceof Error && err.name === "BucketAlreadyOwnedByYou") return;
    throw err;
  }
}
