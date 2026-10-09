import { createHmac, timingSafeEqual } from "node:crypto";

export function parseSignedRequest(signedRequest: string, appSecret: string): Record<string, unknown> {
  const parts = signedRequest.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("malformed signed_request");
  }
  const [encodedSignature, encodedPayload] = parts;

  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  const received = Buffer.from(encodedSignature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("invalid signed_request signature");
  }

  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
}
