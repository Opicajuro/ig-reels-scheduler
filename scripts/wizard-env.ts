import { parse } from "dotenv";

// Created by the wizard with random values, so nobody has to type them.
export const GENERATED_KEYS = ["TOKEN_ENC_KEY"] as const;

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

export function assertPlainValue(key: string, value: string): void {
  if (/["'\r\n]/.test(value)) throw new Error(`${key} cannot contain quotes or line breaks`);
}

// Keeps the template's comments and order, replaces the lines for the given keys,
// and appends any key the template does not have. Values are single-quoted: dotenv and Node's --env-file turn
// \n inside double quotes into a line break, which would break Windows paths such as C:\Users\nina.
export function renderEnv(template: string, values: EnvValues): string {
  const written = new Set<string>();
  const lines = template.split("\n").map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    if (!match || !(match[1] in values)) return line;
    written.add(match[1]);
    return `${match[1]}='${values[match[1]]}'`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!written.has(key)) lines.push(`${key}='${value}'`);
  }
  return lines.join("\n");
}
