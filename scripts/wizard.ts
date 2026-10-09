import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline/promises";
import {
  assertPlainValue,
  fillGeneratedSecrets,
  missingKeys,
  OPTIONAL_KEYS,
  parseEnv,
  renderEnv,
  REQUIRED_KEYS,
  type EnvValues,
} from "./wizard-env";
import { ensureBucket, storageClient } from "./wizard-storage";

const ENV_FILE = ".env";
const ENV_EXAMPLE = ".env.example";
const DEFAULT_APP_URL = "http://localhost:3000";
const WAIT_ATTEMPTS = 30;
const WAIT_MS = 2000;

const PROMPTS: Record<string, string> = {
  RESEND_API_KEY: "Resend API key (starts with re_): ",
  EMAIL_FROM: "Sender address, for example Scheduler <alerts@your-domain.com>: ",
  IG_APP_ID: "Meta app ID (press Enter to skip; needed only to connect Instagram): ",
  IG_APP_SECRET: "Meta app secret (press Enter to skip): ",
};

function run(command: string): boolean {
  try {
    execSync(command, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runOrThrow(command: string, failure: string): void {
  try {
    execSync(command, { stdio: "inherit" });
  } catch {
    throw new Error(failure);
  }
}

function checkPrerequisites(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node ${process.versions.node} is too old. Install Node 22.`);
  if (!run("pnpm --version")) throw new Error("pnpm is not installed. Run: npm install -g pnpm@10.28.0");
  if (!run("docker info")) throw new Error("Docker is not running. Start Docker Desktop, then run pnpm wizard again.");
  if (!run("docker compose version")) throw new Error("Docker Compose is missing. Update Docker Desktop, then run pnpm wizard again.");
}

async function ask(rl: Interface, key: string, required: boolean): Promise<string> {
  for (;;) {
    const answer = (await rl.question(PROMPTS[key])).trim();
    if (answer || !required) return answer;
    console.log(`${key} is required.`);
  }
}

async function prepareEnv(): Promise<EnvValues> {
  const exists = await readFile(ENV_FILE, "utf8").then(
    () => true,
    () => false,
  );
  if (!exists) {
    await copyFile(ENV_EXAMPLE, ENV_FILE);
    console.log(`Created ${ENV_FILE} from ${ENV_EXAMPLE}.`);
  }

  const template = await readFile(ENV_FILE, "utf8");
  const values = fillGeneratedSecrets(parseEnv(template), () => randomBytes(32).toString("base64"));
  if (!values.APP_URL) values.APP_URL = DEFAULT_APP_URL;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const key of missingKeys(values, REQUIRED_KEYS)) values[key] = await ask(rl, key, true);
    for (const key of missingKeys(values, OPTIONAL_KEYS)) values[key] = await ask(rl, key, false);
  } finally {
    rl.close();
  }

  for (const [key, value] of Object.entries(values)) assertPlainValue(key, value);
  await writeFile(ENV_FILE, renderEnv(template, values));
  return values;
}

async function waitFor(name: string, isReady: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 1; attempt <= WAIT_ATTEMPTS; attempt++) {
    if (await isReady()) return;
    console.log(`Waiting for ${name} (${attempt}/${WAIT_ATTEMPTS})...`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }
  throw new Error(`${name} did not start. Run docker compose logs to see why.`);
}

async function storageReady(endpoint: string): Promise<boolean> {
  try {
    return (await fetch(`${endpoint}/minio/health/ready`)).ok;
  } catch {
    return false;
  }
}

async function startServices(values: EnvValues): Promise<void> {
  runOrThrow("docker compose up -d", "docker compose up failed. Read the messages above.");
  await waitFor("Postgres", () => run("docker compose exec -T postgres pg_isready -U app -d ig_reels"));
  await waitFor("file storage", () => storageReady(values.S3_ENDPOINT));
}

async function prepareBucket(values: EnvValues): Promise<void> {
  const client = storageClient(values.S3_ENDPOINT, values.S3_ACCESS_KEY, values.S3_SECRET_KEY);
  await ensureBucket((command) => client.send(command), values.S3_BUCKET);
  console.log(`Storage bucket "${values.S3_BUCKET}" is ready.`);
}

function prepareDatabase(): void {
  runOrThrow("pnpm prisma generate", "prisma generate failed. Read the messages above.");
  runOrThrow("pnpm prisma migrate deploy", "Database migration failed. Read the messages above.");
  console.log("Database is ready.");
}

async function main(): Promise<void> {
  checkPrerequisites();
  const values = await prepareEnv();
  await startServices(values);
  await prepareBucket(values);
  prepareDatabase();
  console.log(`
Setup complete.

  1. Run: pnpm dev
  2. Open ${values.APP_URL} in your browser.
  3. Optional, in a second Git Bash window: pnpm worker
     (transcodes uploaded videos and publishes scheduled posts)
`);
}

main().catch((err: unknown) => {
  console.error(`\nSetup stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
