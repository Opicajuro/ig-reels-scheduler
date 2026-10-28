import { describe, expect, it } from "vitest";
import { buildAlerts, sendEmail } from "./alerts";

const NOW = new Date("2026-10-12T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("buildAlerts", () => {
  it("returns nothing when everything is healthy", () => {
    expect(
      buildAlerts({
        failedPosts: [],
        tokens: [{ username: "streamer", expiresAt: new Date(NOW.getTime() + 30 * DAY) }],
        accounts: [{ username: "streamer", status: "active" }],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("reports each failed post with its error", () => {
    const alerts = buildAlerts({
      failedPosts: [{ id: "post-1", lastError: "video too large" }],
      tokens: [],
      accounts: [],
      now: NOW,
    });
    expect(alerts).toEqual(["Post post-1 failed: video too large"]);
  });

  it("warns about a token expiring within 7 days", () => {
    const alerts = buildAlerts({
      failedPosts: [],
      tokens: [{ username: "streamer", expiresAt: new Date(NOW.getTime() + 5 * DAY) }],
      accounts: [],
      now: NOW,
    });
    expect(alerts).toEqual(["Token for @streamer expires in 5 days"]);
  });

  it("tells the owner when an account needs reauthorization", () => {
    const alerts = buildAlerts({
      failedPosts: [],
      tokens: [],
      accounts: [{ username: "streamer", status: "reauth_required" }],
      now: NOW,
    });
    expect(alerts).toEqual(["@streamer needs to be reconnected"]);
  });
});

describe("sendEmail", () => {
  const SENDER = { apiKey: "re_test", from: "Scheduler <alerts@example.com>" };

  it("posts the message to Resend with the API key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    };

    await sendEmail({ ...SENDER, to: "owner@example.com", subject: "Alerts", text: "Post failed", fetchFn });

    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer re_test");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      from: "Scheduler <alerts@example.com>",
      to: ["owner@example.com"],
      subject: "Alerts",
      text: "Post failed",
    });
  });

  it("throws when Resend refuses the message", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ message: "bad key" }), { status: 401 });
    await expect(sendEmail({ ...SENDER, to: "x@example.com", subject: "s", text: "t", fetchFn })).rejects.toThrow("bad key");
  });
});
