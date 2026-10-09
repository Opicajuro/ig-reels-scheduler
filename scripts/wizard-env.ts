import { parse } from "dotenv";

// Created by the wizard with random values, so nobody has to type them.
export const GENERATED_KEYS = ["TOKEN_ENC_KEY", "AUTH_SECRET"] as const;
// The app reads these when it loads, so it won't start without them.
export const REQUIRED_KEYS = ["RESEND_API_KEY", "EMAIL_FROM"] as const;
// Only needed to connect Instagram accounts.
export const OPTIONAL_KEYS = ["IG_APP_ID", "IG_APP_SECRET"] as const;

export type EnvValues = Record<string, string>;

export function parseEnv(text: string): EnvValues {
  return parse(text);
}

export function fillGeneratedSecrets(values: EnvValues, generate: () => string): EnvValues {
  const filled = { ...values };
  for (const key of GENERATED_KEYS) {
    if (!filled[key]) filled[key] = generate();
  }
  return filled;
}

export function missingKeys(values: EnvValues, keys: readonly string[]): string[] {
  return keys.filter((key) => !values[key]);
}

export function assertPlainValue(key: string, value: string): void {
  if (/["\r\n]/.test(value)) throw new Error(`${key} cannot contain quotes or line breaks`);
}

// Keeps the template's comments and order, replaces the lines for the given keys,
// and appends any key the template does not have.
export function renderEnv(template: string, values: EnvValues): string {
  const written = new Set<string>();
  const lines = template.split("\n").map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !(match[1] in values)) return line;
    written.add(match[1]);
    return `${match[1]}="${values[match[1]]}"`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!written.has(key)) lines.push(`${key}="${value}"`);
  }
  return lines.join("\n");
}
