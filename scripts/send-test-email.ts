// Sends one email through Resend with the app's own settings, to check RESEND_API_KEY and EMAIL_FROM before you
// try to sign in. Run with: pnpm email:test you@example.com
// With the test sender onboarding@resend.dev, Resend only delivers to the email address of your Resend account.
import { sendEmail } from "../src/lib/alerts";

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes("@")) throw new Error("give the address to send to: pnpm email:test you@example.com");
  await sendEmail({ to, subject: "Hello World", text: "Congrats on sending your first email from Localirs!" });
  console.log(`sent to ${to}; check that inbox (and spam)`);
}

main().catch((err) => {
  console.error(`email not sent: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
