import type { PrismaClient } from "@/generated/prisma/client";
import { decryptToken, encryptToken, loadTokenKey } from "./token-crypto";
import { UserError } from "./user-error";

export type Settings = {
  metaAppId: string | null;
  metaAppSecret: string | null;
  alertEmail: string | null;
  resendApiKey: string | null;
  emailFrom: string | null;
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
    return { metaAppId: null, metaAppSecret: null, alertEmail: null, resendApiKey: null, emailFrom: null };
  }
  return {
    metaAppId: row.metaAppId,
    metaAppSecret: row.metaAppSecret === null ? null : openSecret(row.metaAppSecret, loadTokenKey()),
    alertEmail: row.alertEmail,
    resendApiKey: row.resendApiKey === null ? null : openSecret(row.resendApiKey, loadTokenKey()),
    emailFrom: row.emailFrom,
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
