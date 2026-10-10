// Adds a fake Instagram account for local testing, so the schedule forms have an account to pick.
// Run with: pnpm seed:account [--username name] [--expired]
// The token is fake and encrypted with the app's own TOKEN_ENC_KEY, so it decrypts like a real one, but any call to
// Meta with it fails. --expired seeds the account as reauth_required with a token that has already expired.
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/prisma";
import { encryptToken, loadTokenKey } from "../src/lib/token-crypto";

const DAY_MS = 24 * 60 * 60 * 1000;

// The value after a flag, or the fallback when the flag is missing or has no value after it.
export function flagValue(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const username = flagValue(args, "--username", "test_business_account");
  const expired = args.includes("--expired");

  let user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) {
    const email = process.env.SEED_EMAIL ?? "dev@example.com";
    user = await prisma.user.create({ data: { email } });
    console.log(`created user ${email}`);
  }

  const sealed = encryptToken(`fake-token-${randomBytes(16).toString("hex")}`, loadTokenKey());
  const account = await prisma.igAccount.create({
    data: {
      ownerId: user.id,
      igUserId: `seed-${randomBytes(8).toString("hex")}`,
      username,
      accountType: "BUSINESS",
      status: expired ? "reauth_required" : "active",
      token: {
        create: {
          ciphertext: new Uint8Array(sealed.ciphertext),
          iv: new Uint8Array(sealed.iv),
          authTag: new Uint8Array(sealed.authTag),
          expiresAt: new Date(Date.now() + (expired ? -1 : 60) * DAY_MS),
        },
      },
    },
  });
  console.log(`seeded account ${account.id} (@${username}, ${account.status}) for ${user.email}`);
}

if (process.argv[1]?.endsWith("seed-account.ts")) {
  main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
