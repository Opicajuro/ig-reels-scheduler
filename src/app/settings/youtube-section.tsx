import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { youTubeRedirectUri } from "@/lib/youtube";
import { saveYouTubeSettingsAction } from "./youtube-actions";
import styles from "./settings.module.css";

// YouTube uploads go through the owner's own Google Cloud OAuth client, so its quota and consent screen are theirs. The
// client secret is never put in the page.
export async function YouTubeSection() {
  const settings = await getSettings(prisma);
  const saved = settings.googleClientSecret !== null;
  const appUrl = process.env.APP_URL;

  return (
    <Card>
      <div className={styles.stack}>
        <h2>YouTube</h2>
        <p className={styles.note}>
          Needed only to post Shorts to YouTube. Make an OAuth client in your own Google Cloud project, as the{" "}
          <Link href="/help#youtube">Help</Link> page shows, and paste its client ID and secret here.
        </p>
        {appUrl ? (
          <p className={styles.note}>
            Authorized redirect URI to add to the client: <code>{youTubeRedirectUri(appUrl)}</code>
          </p>
        ) : null}
        <ActionForm action={saveYouTubeSettingsAction} className={styles.form}>
          <div className={styles.fields}>
            <Field label="Client ID">
              <input name="googleClientId" defaultValue={settings.googleClientId ?? ""} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Client secret" hint={saved ? "Saved. Type a new one to replace it." : "Not saved yet."}>
              <input name="googleClientSecret" type="password" autoComplete="new-password" placeholder={saved ? "Saved" : ""} />
            </Field>
          </div>
          <div>
            <SubmitButton variant="primary" pendingLabel="Saving…">
              Save YouTube
            </SubmitButton>
          </div>
        </ActionForm>
        <p className={styles.note}>Leave both empty and save to turn YouTube posting off.</p>
      </div>
    </Card>
  );
}
