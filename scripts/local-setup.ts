import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { fillGeneratedSecrets, parseEnv, renderEnv, type EnvValues } from "./wizard-env";
import { ensureBucket, storageClient } from "./wizard-storage";

// Settings for a Windows install where Postgres and MinIO run on this PC, with no Docker.
// The installer passes in the things only it knows: the tool paths and the passwords it chose.
export type LocalInstall = {
  postgresPassword: string;
  minioPassword: string;
  resendApiKey: string;
  emailFrom: string;
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
      S3_SECRET_KEY: install.minioPassword,
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

function requireInstallValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set by the installer`);
  return value;
}

async function main() {
  const install: LocalInstall = {
    postgresPassword: requireInstallValue("LOCALIRS_DB_PASSWORD"),
    minioPassword: requireInstallValue("LOCALIRS_MINIO_PASSWORD"),
    resendApiKey: requireInstallValue("LOCALIRS_RESEND_API_KEY"),
    emailFrom: requireInstallValue("LOCALIRS_EMAIL_FROM"),
    chromePath: requireInstallValue("LOCALIRS_CHROME_PATH"),
    whisperBin: requireInstallValue("LOCALIRS_WHISPER_BIN"),
    whisperModel: requireInstallValue("LOCALIRS_WHISPER_MODEL"),
  };
  const generate = () => randomBytes(32).toString("base64");
  const values = buildLocalValues(install, generate);

  const template = await readFile(".env.example", "utf8");
  const existing = await readFile(".env", "utf8").then(parseEnv).catch(() => ({} as EnvValues));
  // Secrets already in .env are kept, so running setup again does not lock out stored tokens.
  const written = renderEnv(template, { ...values, ...Object.fromEntries(Object.entries(existing).filter(([key]) => key === "TOKEN_ENC_KEY" || key === "AUTH_SECRET")) });
  await writeFile(".env", written);

  await prepareDatabase(requireInstallValue("LOCALIRS_POSTGRES_ADMIN_URL"), install.postgresPassword);

  const s3 = storageClient(values.S3_ENDPOINT, values.S3_ACCESS_KEY, values.S3_SECRET_KEY);
  await ensureBucket((command) => s3.send(command), values.S3_BUCKET);

  // Runs Prisma through Node, so the install needs no pnpm on the PC.
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { stdio: "inherit" });
  console.log("local setup finished: .env written, database and bucket ready, migrations applied");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
