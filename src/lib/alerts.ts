import { requireEnv } from "./env";

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_WARNING_DAYS = 7;
const RESEND_URL = "https://api.resend.com/emails";

export type AlertInput = {
  failedPosts: Array<{ id: string; lastError: string | null }>;
  tokens: Array<{ username: string; expiresAt: Date }>;
  accounts: Array<{ username: string; status: string }>;
  now: Date;
};

export function buildAlerts({ failedPosts, tokens, accounts, now }: AlertInput): string[] {
  const alerts: string[] = [];
  for (const post of failedPosts) {
    alerts.push(`Post ${post.id} failed: ${post.lastError ?? "unknown error"}`);
  }
  for (const token of tokens) {
    const msLeft = token.expiresAt.getTime() - now.getTime();
    if (msLeft > 0 && msLeft <= TOKEN_WARNING_DAYS * DAY_MS) {
      alerts.push(`Token for @${token.username} expires in ${Math.ceil(msLeft / DAY_MS)} days`);
    }
  }
  for (const account of accounts) {
    if (account.status === "reauth_required") alerts.push(`@${account.username} needs to be reconnected`);
  }
  return alerts;
}

export async function sendEmail({
  to,
  subject,
  text,
  fetchFn = fetch,
}: {
  to: string;
  subject: string;
  text: string;
  fetchFn?: typeof fetch;
}) {
  const response = await fetchFn(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: requireEnv("EMAIL_FROM"), to: [to], subject, text }),
  });
  if (!response.ok) {
    const body = (await response.json()) as { message?: string };
    throw new Error(body.message ?? `Resend refused the message with ${response.status}`);
  }
}
