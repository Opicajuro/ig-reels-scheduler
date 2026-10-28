import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { assertPlainValue, fillGeneratedSecrets, parseEnv, renderEnv, type EnvValues } from "./wizard-env";
import { ensureBucket, storageClient } from "./wizard-storage";

// Settings for a Windows install where Postgres and file storage (SeaweedFS) run on this PC, with no Docker.
// The installer passes in the things only it knows: the tool paths and the passwords it chose.
export type LocalInstall = {
  postgresPassword: string;
  storageSecret: string;
  /** optional: failure emails are sent only when all three are set */
  resendApiKey: string;
  emailFrom: string;
  alertEmail: string;
  chromePath: string;
  whisperBin: string;
  whisperModel: string;
};

export function buildLocalValues(install: LocalInstall, generate: () => string): EnvValues {
  return fillGeneratedSecrets(
    {
      DATABASE_URL: `postgresql://localirs:${install.postgresPassword}@127.0.0.1:5432/localirs`,
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_BUCKET: "ig-reels",
      S3_ACCESS_KEY: "localirs",
      S3_SECRET_KEY: install.storageSecret,
      APP_URL: "http://localhost:3000",
      IG_REDIRECT_URI: "http://localhost:3000/api/ig/callback",
      RESEND_API_KEY: install.resendApiKey,
      EMAIL_FROM: install.emailFrom,
      CHROME_PATH: install.chromePath,
      WHISPER_BIN: install.whisperBin,
      WHISPER_MODEL: install.whisperModel,
    },
    generate,
  );
}

// Creates the app's role and database if they do not exist yet. Running it again changes nothing.
export async function prepareDatabase(adminUrl: string, appPassword: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'localirs'");
    if (role.rowCount === 0) {
      await admin.query(`CREATE ROLE localirs LOGIN PASSWORD '${appPassword.replaceAll("'", "''")}'`);
    }
    const database = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'localirs'");
    if (database.rowCount === 0) await admin.query("CREATE DATABASE localirs OWNER localirs");
  } finally {
    await admin.end();
  }
}

// Localirs has no sign-in; everything belongs to the first user row (src/lib/owner.ts). A new install gets that row
// here. Its email is where failure emails go, so a new address from setup replaces the old one.
export async function ensureOwner(databaseUrl: string, alertEmail: string): Promise<void> {
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const owner = await db.query('SELECT id FROM "User" ORDER BY "createdAt" LIMIT 1');
    if (owner.rowCount === 0) {
      await db.query('INSERT INTO "User" (id, email) VALUES ($1, $2)', [randomUUID(), alertEmail || "owner@localhost"]);
    } else if (alertEmail) {
      await db.query('UPDATE "User" SET email = $1 WHERE id = $2', [alertEmail, owner.rows[0].id]);
    }
  } finally {
    await db.end();
  }
}

function requireInstallValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set by the installer`);
  return value;
}

async function main() {
  const install: LocalInstall = {
    postgresPassword: requireInstallValue("LOCALIRS_DB_PASSWORD"),
    storageSecret: requireInstallValue("LOCALIRS_STORAGE_SECRET"),
    resendApiKey: process.env.LOCALIRS_RESEND_API_KEY ?? "",
    emailFrom: process.env.LOCALIRS_EMAIL_FROM ?? "",
    alertEmail: process.env.LOCALIRS_ALERT_EMAIL ?? "",
    chromePath: requireInstallValue("LOCALIRS_CHROME_PATH"),
    whisperBin: requireInstallValue("LOCALIRS_WHISPER_BIN"),
    whisperModel: requireInstallValue("LOCALIRS_WHISPER_MODEL"),
  };
  const generate = () => randomBytes(32).toString("base64");
  const values = buildLocalValues(install, generate);
  for (const [key, value] of Object.entries(values)) assertPlainValue(key, value);

  const template = await readFile(".env.example", "utf8");
  const existing = await readFile(".env", "utf8").then(parseEnv).catch(() => ({} as EnvValues));
  // Secrets already in .env are kept, so running setup again does not lock out stored tokens.
  const written = renderEnv(template, { ...values, ...Object.fromEntries(Object.entries(existing).filter(([key]) => key === "TOKEN_ENC_KEY")) });
  await writeFile(".env", written);

  await prepareDatabase(requireInstallValue("LOCALIRS_POSTGRES_ADMIN_URL"), install.postgresPassword);

  const s3 = storageClient(values.S3_ENDPOINT, values.S3_ACCESS_KEY, values.S3_SECRET_KEY);
  // The storage port opens a moment before SeaweedFS answers S3 requests, so the first tries may fail.
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureBucket((command) => s3.send(command), values.S3_BUCKET);
      break;
    } catch (err) {
      if (attempt === 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // Runs Prisma through Node, so the install needs no pnpm on the PC.
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "inherit" });
  await ensureOwner(values.DATABASE_URL, install.alertEmail);
  console.log("local setup finished: .env written, database and bucket ready, migrations applied, owner ready");
}

// True when this module is the script node was started with. A plain `file://` + path comparison fails on Windows
// (C:\ paths) and for any path with a space, so the path goes through pathToFileURL.
export function isEntryPoint(moduleUrl: string, scriptPath: string | undefined): boolean {
  return scriptPath !== undefined && moduleUrl === pathToFileURL(scriptPath).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
