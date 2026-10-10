// Adds a fake Instagram account for local testing, so the schedule forms have an account to pick.
// Run with: pnpm seed:account [--username name] [--expired]
// Uses the same mock account as the IG_MOCK button on /accounts (src/lib/mock-accounts.ts). --expired seeds the
// account as reauth_required with a token that has already expired.
import { createMockAccount } from "../src/lib/mock-accounts";
import { prisma } from "../src/lib/prisma";
import { loadTokenKey } from "../src/lib/token-crypto";

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

  const account = await createMockAccount(prisma, { ownerId: user.id, key: loadTokenKey(), username, expired });
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
