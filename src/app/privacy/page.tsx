import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { PageHeader } from "@/components/page-header";
import { ExternalLink } from "@/components/platform-links";
import { getOwnerId } from "@/lib/owner";
import { platformName } from "@/lib/platforms";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";

export const metadata: Metadata = { title: "Privacy policy" };

export default async function PrivacyPage() {
  await connection();
  // The contact is the failure-email address from Settings.
  const { alertEmail } = await getSettings(prisma);
  // The owner's profiles from Settings are contacts too.
  const profiles = await prisma.profileLink.findMany({ where: { ownerId: await getOwnerId() }, orderBy: { createdAt: "asc" } });

  return (
    <main>
      <PageHeader title="Privacy policy" />
      <h2>What we store</h2>
      <ul>
        <li>Your Instagram account ID, username, and account type (Business or Creator).</li>
        <li>Your Instagram access token, encrypted at rest.</li>
        <li>Videos you upload, the clips made from them, captions, and scheduled publish times.</li>
        <li>Publishing results and basic performance numbers for your posts.</li>
      </ul>

      <h2>How we use it</h2>
      <p>Only to schedule and publish the posts you create, and to show you their results.</p>

      <h2>Removing your data</h2>
      <p>
        You can disconnect an account at any time, which stops all publishing for it. You can also remove the app
        in Instagram settings, or request deletion, which permanently deletes the stored data for that account.
      </p>

      <h2>Contact</h2>
      {alertEmail ? (
        <p>
          Questions or deletion requests: <a href={`mailto:${alertEmail}`}>{alertEmail}</a>
        </p>
      ) : profiles.length > 0 ? null : (
        <p>
          No contact address yet. Add your email address under Failure emails on the{" "}
          <Link href="/settings">Settings</Link> page.
        </p>
      )}
      {profiles.length > 0 ? (
        <>
          <p>{alertEmail ? "You can also reach us on:" : "Questions or deletion requests:"}</p>
          <ul>
            {profiles.map((profile) => (
              <li key={profile.id}>
                <ExternalLink href={profile.url}>{platformName(profile.url)}</ExternalLink>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  );
}
