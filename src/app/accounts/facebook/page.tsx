import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { FACEBOOK_PICK_COOKIE, listManagedPages, type ManagedPage } from "@/lib/facebook";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { openSecret } from "@/lib/settings";
import { loadTokenKey } from "@/lib/token-crypto";
import { connectFacebookPagesAction } from "./actions";
import styles from "../accounts.module.css";

export const metadata: Metadata = { title: "Pick Facebook Pages" };

// After Facebook's login: the Pages this person can publish to, to tick the ones Localirs posts Reels to.
export default async function PickFacebookPagesPage() {
  await connection();
  const sealed = (await cookies()).get(FACEBOOK_PICK_COOKIE)?.value;
  if (!sealed) {
    return (
      <main>
        <PageHeader title="Pick Facebook Pages" />
        <Alert tone="info">
          The Facebook login expired or has not started. Press <strong>Connect Facebook Page</strong> on the{" "}
          <Link href="/accounts">Accounts</Link> page.
        </Alert>
      </main>
    );
  }

  let pages: ManagedPage[] = [];
  let error: string | null = null;
  try {
    pages = await listManagedPages({ userToken: openSecret(sealed, loadTokenKey()) });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const connected = new Set(
    (await prisma.fbPage.findMany({ where: { ownerId: await getOwnerId(), status: "active" } })).map((page) => page.pageId),
  );

  return (
    <main>
      <PageHeader title="Pick Facebook Pages" description="The Pages you can publish to. Localirs posts Reels to the ones you tick." />
      {error ? <Alert tone="error">Facebook did not list your Pages: {error}</Alert> : null}
      {!error && pages.length === 0 ? (
        <EmptyState>
          Facebook listed no Page you can publish to. You need a Page where you can create content, and you must choose it
          during Facebook&apos;s login.
        </EmptyState>
      ) : null}
      {pages.length > 0 ? (
        <Card>
          <ActionForm action={connectFacebookPagesAction} className={styles.list}>
            {pages.map((page) => (
              <label key={page.pageId}>
                <input type="checkbox" name="pageId" value={page.pageId} defaultChecked={pages.length === 1 || connected.has(page.pageId)} />{" "}
                {page.name}
                {connected.has(page.pageId) ? <span className={styles.muted}> · connected; saving renews its login</span> : null}
              </label>
            ))}
            <div>
              <SubmitButton variant="primary" pendingLabel="Connecting…">
                Connect the ticked Pages
              </SubmitButton>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </main>
  );
}
