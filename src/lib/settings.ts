import type { PrismaClient } from "@/generated/prisma/client";
import { decryptToken, encryptToken, loadTokenKey } from "./token-crypto";
import { UserError } from "./user-error";

export type Settings = {
  metaAppId: string | null;
  metaAppSecret: string | null;
  alertEmail: string | null;
  resendApiKey: string | null;
  emailFrom: string | null;
  r2AccountId: string | null;
  r2AccessKeyId: string | null;
  r2SecretAccessKey: string | null;
  r2Bucket: string | null;
};

// What the settings form sends. An empty secret keeps the saved one, so the page never has to send a secret back.
export type SettingsInput = {
  metaAppId: string;
  metaAppSecret: string;
  alertEmail: string;
  resendApiKey: string;
  emailFrom: string;
};

const SETTINGS_ID = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

// A secret is stored as one base64 text: the IV, then the auth tag, then the ciphertext.
export function sealSecret(plaintext: string, key: Buffer): string {
  const { iv, authTag, ciphertext } = encryptToken(plaintext, key);
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function openSecret(sealed: string, key: Buffer): string {
  const bytes = Buffer.from(sealed, "base64");
  return decryptToken(
    {
      iv: bytes.subarray(0, IV_BYTES),
      authTag: bytes.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES),
      ciphertext: bytes.subarray(IV_BYTES + AUTH_TAG_BYTES),
    },
    key,
  );
}

// Read on every use, not cached, so a save on /settings takes effect in the web app and the worker at once.
export async function getSettings(db: PrismaClient): Promise<Settings> {
  const row = await db.setting.findUnique({ where: { id: SETTINGS_ID } });
  if (!row) {
    return {
      metaAppId: null,
      metaAppSecret: null,
      alertEmail: null,
      resendApiKey: null,
      emailFrom: null,
      r2AccountId: null,
      r2AccessKeyId: null,
      r2SecretAccessKey: null,
      r2Bucket: null,
    };
  }
  return {
    metaAppId: row.metaAppId,
    metaAppSecret: row.metaAppSecret === null ? null : openSecret(row.metaAppSecret, loadTokenKey()),
    alertEmail: row.alertEmail,
    resendApiKey: row.resendApiKey === null ? null : openSecret(row.resendApiKey, loadTokenKey()),
    emailFrom: row.emailFrom,
    r2AccountId: row.r2AccountId,
    r2AccessKeyId: row.r2AccessKeyId,
    r2SecretAccessKey: row.r2SecretAccessKey === null ? null : openSecret(row.r2SecretAccessKey, loadTokenKey()),
    r2Bucket: row.r2Bucket,
  };
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export async function saveSettings(db: PrismaClient, input: SettingsInput): Promise<void> {
  const alertEmail = orNull(input.alertEmail);
  if (alertEmail !== null && !/^[^\s@]+@[^\s@]+$/.test(alertEmail)) {
    throw new UserError("the failure-email address does not look like an email address");
  }

  const saved = await db.setting.findUnique({ where: { id: SETTINGS_ID } });
  const metaAppSecret = orNull(input.metaAppSecret);
  const resendApiKey = orNull(input.resendApiKey);
  const emailFrom = orNull(input.emailFrom);
  const hasResendKey = resendApiKey !== null || Boolean(saved?.resendApiKey);
  if ((alertEmail !== null || emailFrom !== null) && !(alertEmail !== null && emailFrom !== null && hasResendKey)) {
    throw new UserError("failure emails need all three: your email address, the Resend API key and the sender");
  }

  const data = {
    metaAppId: orNull(input.metaAppId),
    alertEmail,
    emailFrom,
    ...(metaAppSecret === null ? {} : { metaAppSecret: sealSecret(metaAppSecret, loadTokenKey()) }),
    ...(resendApiKey === null ? {} : { resendApiKey: sealSecret(resendApiKey, loadTokenKey()) }),
  };
  await db.setting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
}

// What the Cloudflare R2 form sends. An empty secret access key keeps the saved one.
export type R2SettingsInput = {
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
};

// All four values, or none to turn Instagram posting off.
export async function saveR2Settings(db: PrismaClient, input: R2SettingsInput): Promise<void> {
  const r2AccountId = orNull(input.r2AccountId);
  const r2AccessKeyId = orNull(input.r2AccessKeyId);
  const r2SecretAccessKey = orNull(input.r2SecretAccessKey);
  const r2Bucket = orNull(input.r2Bucket);

  if (r2AccountId === null && r2AccessKeyId === null && r2SecretAccessKey === null && r2Bucket === null) {
    const data = { r2AccountId: null, r2AccessKeyId: null, r2SecretAccessKey: null, r2Bucket: null };
    await db.setting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
    return;
  }

  const saved = await db.setting.findUnique({ where: { id: SETTINGS_ID } });
  const hasSecret = r2SecretAccessKey !== null || Boolean(saved?.r2SecretAccessKey);
  if (r2AccountId === null || r2AccessKeyId === null || r2Bucket === null || !hasSecret) {
    throw new UserError("Cloudflare R2 needs all four: the account ID, the access key ID, the secret access key and the bucket name");
  }
  if (!/^[0-9a-f]{32}$/i.test(r2AccountId)) {
    throw new UserError("the R2 account ID is 32 letters and digits, shown on the R2 overview page in Cloudflare");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(r2Bucket)) {
    throw new UserError("an R2 bucket name is 3 to 63 lowercase letters, digits and hyphens");
  }

  const data = {
    r2AccountId,
    r2AccessKeyId,
    r2Bucket,
    ...(r2SecretAccessKey === null ? {} : { r2SecretAccessKey: sealSecret(r2SecretAccessKey, loadTokenKey()) }),
  };
  await db.setting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
}

// Setup copies values it was given (by the installer, or from an older .env) into the settings, but only where the
// settings have no value yet, so running setup again never undoes a change made on /settings.
export async function fillMissingSettings(
  db: PrismaClient,
  values: Pick<Settings, "metaAppId" | "metaAppSecret" | "alertEmail" | "resendApiKey" | "emailFrom">,
): Promise<void> {
  const saved = await db.setting.findUnique({ where: { id: SETTINGS_ID } });
  const data: Record<string, string> = {};
  for (const [field, value] of Object.entries(values) as Array<[keyof typeof values, string | null]>) {
    if (!value || saved?.[field]) continue;
    data[field] = field === "metaAppSecret" || field === "resendApiKey" ? sealSecret(value, loadTokenKey()) : value;
  }
  if (Object.keys(data).length === 0) return;
  await db.setting.upsert({ where: { id: SETTINGS_ID }, create: { id: SETTINGS_ID, ...data }, update: data });
}

// Failure emails are on once the address, the Resend key and the sender are all saved.
export function emailSettings(settings: Settings): { to: string; apiKey: string; from: string } | null {
  const { alertEmail, resendApiKey, emailFrom } = settings;
  return alertEmail && resendApiKey && emailFrom ? { to: alertEmail, apiKey: resendApiKey, from: emailFrom } : null;
}

export type R2Config = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string };

// Instagram posting is on once all four R2 values are saved.
export function r2Settings(settings: Settings): R2Config | null {
  const { r2AccountId, r2AccessKeyId, r2SecretAccessKey, r2Bucket } = settings;
  return r2AccountId && r2AccessKeyId && r2SecretAccessKey && r2Bucket
    ? { accountId: r2AccountId, accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey, bucket: r2Bucket }
    : null;
}
