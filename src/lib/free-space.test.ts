import os from "node:os";
import { describe, expect, it } from "vitest";
import { driveFreeBytes, MIN_FREE_BYTES, requireFreeSpace } from "./free-space";
import { UserError } from "./user-error";

const dataDir = os.tmpdir();

describe("requireFreeSpace", () => {
  it("lets a job start with 2 GB free", async () => {
    await expect(requireFreeSpace(dataDir, async () => MIN_FREE_BYTES)).resolves.toBeUndefined();
  });

  it("refuses below 2 GB free, with a link to the Storage page", async () => {
    const refused = await requireFreeSpace(dataDir, async () => MIN_FREE_BYTES - 1).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(UserError);
    expect((refused as UserError).message).toMatch(/^Only 2\.0 GB is free on the data drive, and this needs at least 2\.0 GB/);
    expect((refused as UserError).link).toEqual({ href: "/storage", label: "Open Storage" });
  });

  it("reads the drive's free space with statfs", async () => {
    expect(await driveFreeBytes(dataDir)).toBeGreaterThan(0);
  });
});
