import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return (
    <main>
      <PageHeader title="Privacy policy" />
      <p>
        <strong>Draft:</strong> replace this text and the contact details before submitting the app for Meta App
        Review.
      </p>

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
      <p>[contact email to be added]</p>
    </main>
  );
}
