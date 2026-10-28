// Sends one email through Resend with the failure-email settings saved on /settings, to check them.
// Run with: pnpm email:test you@example.com
// With the test sender onboarding@resend.dev, Resend only delivers to the email address of your Resend account.
import { sendEmail } from "../src/lib/alerts";
import { prisma } from "../src/lib/prisma";
import { emailSettings, getSettings } from "../src/lib/settings";

async function main() {
  const to = process.argv[2];
  if (!to || !to.includes("@")) throw new Error("give the address to send to: pnpm email:test you@example.com");
  const email = emailSettings(await getSettings(prisma));
  if (!email) throw new Error("failure emails are not set up; add them on the Settings page");
  await sendEmail({ ...email, to, subject: "Hello World", text: "Congrats on sending your first email from Localirs!" });
  console.log(`sent to ${to}; check that inbox (and spam)`);
}

main()
  .catch((err) => {
    console.error(`email not sent: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
