import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { saveR2SettingsAction, testR2Action } from "./r2-actions";
import styles from "./settings.module.css";

// Instagram downloads each Reel from a link, so the video is copied to the user's R2 bucket just before posting and
// deleted from it afterwards. The secret access key is never put in the page.
export async function R2Section() {
  const settings = await getSettings(prisma);
  const saved = settings.r2SecretAccessKey !== null;

  return (
    <Card>
      <div className={styles.stack}>
        <h2>Cloudflare R2 (for Instagram posting)</h2>
        <p className={styles.note}>
          Instagram fetches each Reel from a web link, and your videos are only on this PC. Just before a post goes out,
          its video is copied to your R2 bucket, Instagram gets a link that works for one hour, and the copy is deleted
          once the post is published, failed or canceled. R2&apos;s free tier covers this.
        </p>
        <ol className={styles.note}>
          <li>
            In the Cloudflare dashboard, open <strong>R2 Object Storage</strong> (add a payment method if asked; the free
            tier is not charged) and <strong>Create bucket</strong>, for example <code>localirs-ig</code>.
          </li>
          <li>Copy the <strong>Account ID</strong> shown on the R2 overview page.</li>
          <li>
            Under <strong>Manage API tokens</strong>, create an API token with <strong>Object Read &amp; Write</strong>,
            applied to that bucket only.
          </li>
          <li>Copy its Access Key ID and Secret Access Key below. Cloudflare shows the secret only once.</li>
        </ol>
        <p className={styles.note}>
          More in <a href="https://developers.cloudflare.com/r2/">Cloudflare&apos;s R2 documentation</a>. Leave all four
          empty and save to turn Instagram posting off.
        </p>
        <ActionForm action={saveR2SettingsAction} className={styles.form}>
          <div className={styles.fields}>
            <Field label="Account ID">
              <input name="r2AccountId" defaultValue={settings.r2AccountId ?? ""} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Bucket name">
              <input name="r2Bucket" defaultValue={settings.r2Bucket ?? ""} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Access key ID">
              <input name="r2AccessKeyId" defaultValue={settings.r2AccessKeyId ?? ""} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label="Secret access key" hint={saved ? "Saved. Type a new one to replace it." : "Not saved yet."}>
              <input name="r2SecretAccessKey" type="password" autoComplete="new-password" placeholder={saved ? "Saved" : ""} />
            </Field>
          </div>
          <div>
            <SubmitButton variant="primary" pendingLabel="Saving…">
              Save R2
            </SubmitButton>
          </div>
        </ActionForm>
        {saved ? (
          <ActionForm action={testR2Action} className={styles.row}>
            <span>Uploads a small file, downloads it through a link, and deletes it.</span>
            <SubmitButton pendingLabel="Testing…">Test connection</SubmitButton>
          </ActionForm>
        ) : null}
      </div>
    </Card>
  );
}
