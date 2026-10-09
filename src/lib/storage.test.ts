import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRawKey, buildReelKey, presignDownload, presignUpload } from "./storage";

const ENV = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "ig-reels",
  S3_ACCESS_KEY: "test-access",
  S3_SECRET_KEY: "test-secret",
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});

afterEach(() => {
  for (const name of Object.keys(ENV)) delete process.env[name];
});

describe("storage keys", () => {
  it("puts raw uploads under raw/ and reels under reels/", () => {
    expect(buildRawKey("abc", ".MOV")).toBe("raw/abc.mov");
    expect(buildReelKey("abc")).toBe("reels/abc.mp4");
  });
});

describe("presignUpload", () => {
  it("returns a PUT URL for the bucket and key that expires in 2 hours", async () => {
    const url = new URL(await presignUpload("raw/abc.mp4", "video/mp4"));
    expect(url.origin).toBe("http://localhost:9000");
    expect(url.pathname).toBe("/ig-reels/raw/abc.mp4");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("7200");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });
});

describe("presignDownload", () => {
  it("returns a GET URL valid for the given lifetime", async () => {
    const url = new URL(await presignDownload("reels/abc.mp4", 7200));
    expect(url.pathname).toBe("/ig-reels/reels/abc.mp4");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("7200");
  });
});
