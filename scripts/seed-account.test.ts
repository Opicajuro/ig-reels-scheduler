import { describe, expect, it } from "vitest";
import { flagValue } from "./seed-account";

describe("flagValue", () => {
  it("reads the value after the flag", () => {
    expect(flagValue(["--username", "clips_daily"], "--username", "x")).toBe("clips_daily");
  });

  it("falls back when the flag is missing, instead of taking the first argument", () => {
    expect(flagValue(["--expired"], "--username", "test_business_account")).toBe("test_business_account");
  });

  it("falls back when the flag has no value or is followed by another flag", () => {
    expect(flagValue(["--username"], "--username", "x")).toBe("x");
    expect(flagValue(["--username", "--expired"], "--username", "x")).toBe("x");
  });
});
