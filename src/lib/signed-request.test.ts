import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSignedRequest } from "./signed-request";

const SECRET = "test-app-secret";

function sign(payload: object, secret = SECRET): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${signature}.${encodedPayload}`;
}

describe("parseSignedRequest", () => {
  it("returns the payload when the signature matches", () => {
    const signed = sign({ user_id: "17841", algorithm: "HMAC-SHA256" });
    expect(parseSignedRequest(signed, SECRET)).toEqual({
      user_id: "17841",
      algorithm: "HMAC-SHA256",
    });
  });

  it("rejects a signature made with a different secret", () => {
    const signed = sign({ user_id: "17841" }, "wrong-secret");
    expect(() => parseSignedRequest(signed, SECRET)).toThrow("invalid signed_request signature");
  });

  it("rejects a payload that was changed after signing", () => {
    const signed = sign({ user_id: "17841" });
    const [signature] = signed.split(".");
    const forged = Buffer.from(JSON.stringify({ user_id: "99999" })).toString("base64url");
    expect(() => parseSignedRequest(`${signature}.${forged}`, SECRET)).toThrow(
      "invalid signed_request signature",
    );
  });

  it("rejects a value that is not in signed_request format", () => {
    expect(() => parseSignedRequest("no-dot-here", SECRET)).toThrow("malformed signed_request");
  });
});
