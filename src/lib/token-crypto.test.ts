import { afterEach, describe, expect, it } from "vitest";
import { decryptToken, encryptToken, loadTokenKey } from "./token-crypto";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const TOKEN = "IGQWRP-test-token-value";

afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
});

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", () => {
    const sealed = encryptToken(TOKEN, KEY);
    expect(decryptToken(sealed, KEY)).toBe(TOKEN);
  });

  it("never stores the plaintext", () => {
    const sealed = encryptToken(TOKEN, KEY);
    expect(sealed.ciphertext.includes(Buffer.from(TOKEN))).toBe(false);
  });

  it("uses a fresh IV for each encryption", () => {
    const first = encryptToken(TOKEN, KEY);
    const second = encryptToken(TOKEN, KEY);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("rejects a tampered ciphertext", () => {
    const sealed = encryptToken(TOKEN, KEY);
    sealed.ciphertext[0] ^= 0xff;
    expect(() => decryptToken(sealed, KEY)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const sealed = encryptToken(TOKEN, KEY);
    sealed.authTag[0] ^= 0xff;
    expect(() => decryptToken(sealed, KEY)).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    const sealed = encryptToken(TOKEN, KEY);
    expect(() => decryptToken(sealed, OTHER_KEY)).toThrow();
  });
});

describe("loadTokenKey", () => {
  it("reads a base64 32-byte key from TOKEN_ENC_KEY", () => {
    process.env.TOKEN_ENC_KEY = KEY.toString("base64");
    expect(loadTokenKey().equals(KEY)).toBe(true);
  });

  it("throws when TOKEN_ENC_KEY is missing", () => {
    expect(() => loadTokenKey()).toThrow("TOKEN_ENC_KEY is not set");
  });

  it("throws when the key is not 32 bytes", () => {
    process.env.TOKEN_ENC_KEY = Buffer.alloc(16).toString("base64");
    expect(() => loadTokenKey()).toThrow("TOKEN_ENC_KEY must decode to 32 bytes");
  });
});
