import { describe, expect, it } from "vitest";
import { signInErrorMessage } from "./sign-in-errors";

describe("signInErrorMessage", () => {
  it("shows nothing when there is no error", () => {
    expect(signInErrorMessage(undefined)).toBeNull();
    expect(signInErrorMessage("")).toBeNull();
  });

  it("explains a failed sign-in email and points to the log and to setup", () => {
    const message = signInErrorMessage("Configuration");
    expect(message).toContain("web.err.log");
    expect(message).toContain("Set up Localirs");
  });

  it("explains an expired link", () => {
    expect(signInErrorMessage("Verification")).toMatch(/expired/);
  });

  it("falls back to a general message for codes it does not know", () => {
    expect(signInErrorMessage("SomethingNew")).toContain("web.err.log");
  });
});
