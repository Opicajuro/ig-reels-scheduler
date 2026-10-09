import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEnv } from "./env";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type SealedToken = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

export function loadTokenKey(): Buffer {
  const key = Buffer.from(requireEnv("TOKEN_ENC_KEY"), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes`);
  }
  return key;
}

export function encryptToken(plaintext: string, key: Buffer): SealedToken {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptToken({ ciphertext, iv, authTag }: SealedToken, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
