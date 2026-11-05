import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { tikTokRedirectUri, TIKTOK_SCOPES } from "@/lib/tiktok";
import { saveTikTokSettingsAction } from "./tiktok-actions";
import styles from "./settings.module.css";

// TikTok drafts go through the owner's own TikTok developer app. The client secret is never put in the page.
export async function TikTokSection() {
  const settings = await getSettings(prisma);
  const saved = settings.tiktokClientSecret !== null;
  const appUrl = process.env.APP_URL;

  return (
    <Card>
      <div className={styles.stack}>
        <h2>TikTok</h2>
        <p className={styles.note}>
          Needed only to send clips to TikTok as drafts. Make an app on TikTok for Developers with Login Kit and the Content
          Posting API (scopes {TIKTOK_SCOPES.join(", ")}), as the <Link href="/help#tiktok">Help</Link> page shows, and paste its
          client key and secret here.
        </p>
        {appUrl ? (
          <p className={styles.note}>
            Redirect URI to add under Login Kit: <code>{tikTokRedirectUri(appUrl)}</code>
          </p>
        ) : null}
        <ActionForm action={saveTikTokSettingsAction} className={styles.form}>
          <div className={styles.fields}>
            <Field label="Client key">
              <input name="tiktokClientKey" defaultValue={settings.tiktokClientKey ?? ""} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Client secret" hint={saved ? "Saved. Type a new one to replace it." : "Not saved yet."}>
              <input name="tiktokClientSecret" type="password" autoComplete="new-password" placeholder={saved ? "Saved" : ""} />
            </Field>
          </div>
          <div>
            <SubmitButton variant="primary" pendingLabel="Saving…">
              Save TikTok
            </SubmitButton>
          </div>
        </ActionForm>
        <p className={styles.note}>Leave both empty and save to turn TikTok off.</p>
      </div>
    </Card>
  );
}
