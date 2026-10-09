import type { CreateBucketCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ensureBucket } from "./wizard-storage";

function fakeSend(errorName?: string) {
  const sent: CreateBucketCommand[] = [];
  const send = async (command: CreateBucketCommand) => {
    sent.push(command);
    if (errorName) throw Object.assign(new Error(errorName), { name: errorName });
    return {};
  };
  return { send, sent };
}

describe("ensureBucket", () => {
  it("creates the bucket the app will read from", async () => {
    const { send, sent } = fakeSend();

    await ensureBucket(send, "ig-reels");

    expect(sent).toHaveLength(1);
    expect(sent[0].input.Bucket).toBe("ig-reels");
  });

  it("accepts a bucket that this account already owns", async () => {
    const { send } = fakeSend("BucketAlreadyOwnedByYou");

    await expect(ensureBucket(send, "ig-reels")).resolves.toBeUndefined();
  });

  it("throws for any other storage error", async () => {
    const { send } = fakeSend("AccessDenied");

    await expect(ensureBucket(send, "ig-reels")).rejects.toThrow("AccessDenied");
  });
});
