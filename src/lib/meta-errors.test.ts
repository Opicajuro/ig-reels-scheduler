import { describe, expect, it } from "vitest";
import { classifyMetaError, MetaApiError } from "./meta-errors";

describe("classifyMetaError", () => {
  it("retries 5xx responses", () => {
    expect(classifyMetaError(new MetaApiError(503, undefined, "unavailable"))).toBe("retry");
  });

  it("retries Meta rate-limit codes 4, 17, 32 and 613", () => {
    for (const code of [4, 17, 32, 613]) {
      expect(classifyMetaError(new MetaApiError(400, code, "limit"))).toBe("retry");
    }
  });

  it("retries network errors", () => {
    expect(classifyMetaError(new TypeError("fetch failed"))).toBe("retry");
  });

  it("marks error 190 as reauthorization", () => {
    expect(classifyMetaError(new MetaApiError(400, 190, "expired"))).toBe("reauth");
  });

  it("fails other 4xx responses immediately", () => {
    expect(classifyMetaError(new MetaApiError(400, 100, "bad param"))).toBe("fail");
  });
});
