import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertPlainValue, fillGeneratedSecrets, missingKeys, parseEnv, renderEnv } from "./wizard-env";

const TEMPLATE = [
  "# Settings for the scheduler",
  'DATABASE_URL="postgresql://app:app@localhost:5432/ig_reels"',
  'TOKEN_ENC_KEY=""',
  'AUTH_SECRET=""',
  'RESEND_API_KEY=""',
  'APP_URL=""',
  "",
].join("\n");

describe("fillGeneratedSecrets", () => {
  it("fills empty secrets with 32-byte keys and keeps secrets that are already set", () => {
    const values = { TOKEN_ENC_KEY: "", AUTH_SECRET: "already-set" };

    const filled = fillGeneratedSecrets(values, () => randomBytes(32).toString("base64"));

    expect(filled.AUTH_SECRET).toBe("already-set");
    expect(Buffer.from(filled.TOKEN_ENC_KEY, "base64")).toHaveLength(32);
  });
});

describe("renderEnv and parseEnv", () => {
  it("replaces only the given keys, keeps comments and quotes, and reads back the same values", () => {
    const values = { ...parseEnv(TEMPLATE), TOKEN_ENC_KEY: "abc+/=", RESEND_API_KEY: "re_123" };

    const text = renderEnv(TEMPLATE, values);

    expect(text).toContain("# Settings for the scheduler");
    expect(text).toContain('DATABASE_URL="postgresql://app:app@localhost:5432/ig_reels"');
    expect(parseEnv(text)).toEqual(values);
  });

  it("appends keys that the template does not have", () => {
    const text = renderEnv('A="1"\n', { A: "1", B: "2" });

    expect(parseEnv(text)).toEqual({ A: "1", B: "2" });
  });
});

describe("missingKeys", () => {
  it("lists the keys that are still empty", () => {
    const values = { RESEND_API_KEY: "", EMAIL_FROM: "Scheduler <a@example.com>" };

    expect(missingKeys(values, ["RESEND_API_KEY", "EMAIL_FROM"])).toEqual(["RESEND_API_KEY"]);
  });
});

describe("assertPlainValue", () => {
  it("rejects values that would break a .env line", () => {
    expect(() => assertPlainValue("EMAIL_FROM", 'Scheduler "alerts"')).toThrow("EMAIL_FROM");
    expect(() => assertPlainValue("EMAIL_FROM", "line one\nline two")).toThrow("EMAIL_FROM");
  });

  it("accepts an ordinary sender address", () => {
    expect(() => assertPlainValue("EMAIL_FROM", "Scheduler <alerts@example.com>")).not.toThrow();
  });
});
