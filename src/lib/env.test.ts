import { afterEach, describe, expect, it } from "vitest";
import { requireEnv } from "./env";

const NAME = "IG_REELS_TEST_VALUE";

afterEach(() => {
  delete process.env[NAME];
});

describe("requireEnv", () => {
  it("returns the value when the variable is set", () => {
    process.env[NAME] = "abc";
    expect(requireEnv(NAME)).toBe("abc");
  });

  it("throws naming the variable when it is missing", () => {
    expect(() => requireEnv(NAME)).toThrow(`${NAME} is not set`);
  });

  it("throws when the variable is empty", () => {
    process.env[NAME] = "";
    expect(() => requireEnv(NAME)).toThrow(`${NAME} is not set`);
  });
});
