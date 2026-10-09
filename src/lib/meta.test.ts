import { describe, expect, it } from "vitest";
import { META_API_VERSION } from "./meta";

describe("META_API_VERSION", () => {
  it("pins the Graph API version used for every Meta call", () => {
    expect(META_API_VERSION).toBe("v26.0");
  });
});
