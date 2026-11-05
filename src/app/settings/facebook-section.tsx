import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { facebookRedirectUri, FACEBOOK_PERMISSIONS } from "@/lib/facebook";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { saveFacebookSettingsAction } from "./facebook-actions";
import styles from "./settings.module.css";

// Facebook Pages go through the same Meta app as Instagram, with the Facebook Login for Business product added to it:
// Instagram Login gives no access to Pages.
export async function FacebookSection() {
  const settings = await getSettings(prisma);
  const appUrl = process.env.APP_URL;

  return (
    <Card>
      <div className={styles.stack}>
        <h2>Facebook Pages</h2>
        <p className={styles.note}>
          Needed only to post Reels to a Facebook Page. Instagram Login does not give access to Pages, so add the{" "}
          <strong>Facebook Login for Business</strong> product to the same Meta app (its app ID and secret above), make a
          configuration with the permissions {FACEBOOK_PERMISSIONS.join(", ")}, and paste its configuration ID here. The{" "}
          <Link href="/help#facebook">Help</Link> page shows the steps.
        </p>
        {appUrl ? (
          <p className={styles.note}>
            Valid OAuth redirect URI to add under Facebook Login for Business, Settings: <code>{facebookRedirectUri(appUrl)}</code>
          </p>
        ) : null}
        {settings.metaAppId ? null : <p className={styles.note}>Save the Meta app&apos;s ID and secret above first.</p>}
        <ActionForm action={saveFacebookSettingsAction} className={styles.form}>
          <div className={styles.fields}>
            <Field label="Configuration ID" hint="Under Facebook Login for Business, Configurations.">
              <input
                name="fbLoginConfigId"
                defaultValue={settings.fbLoginConfigId ?? ""}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          </div>
          <div>
            <SubmitButton variant="primary" pendingLabel="Saving…">
              Save Facebook
            </SubmitButton>
          </div>
        </ActionForm>
        <p className={styles.note}>Leave it empty and save to turn Facebook posting off.</p>
      </div>
    </Card>
  );
}
