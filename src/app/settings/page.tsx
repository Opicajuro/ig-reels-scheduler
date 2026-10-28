import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card } from "@/components/card";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { CAPTION_LANGUAGES, getSettings } from "@/lib/settings";
import { saveSettingsAction } from "./actions";
import styles from "./settings.module.css";

export const metadata: Metadata = { title: "Settings" };

// The log files the installed app writes to its data folder (installer/services.ps1 and the setup scripts).
const LOG_FILES = ["web.log", "web.err.log", "worker.log", "worker.err.log", "start.log", "setup.log", "postgres.log"];

export default async function SettingsPage() {
  await connection();
  const settings = await getSettings(prisma);
  // An installed copy runs from <install>\app and keeps its database, videos and logs in <install>\data.
  const appFolder = process.cwd();
  const dataFolder = path.resolve(appFolder, "..", "data");
  const installed = existsSync(dataFolder);

  // The secrets are never put in the page: their fields start empty and say whether one is saved.
  return (
    <main>
      <PageHeader title="Settings" description="Changes take effect as soon as they are saved, without a restart." />
      <ActionForm action={saveSettingsAction} className={styles.form}>
        <Card>
          <h2>Meta app</h2>
          <p className={styles.note}>Needed only to connect Instagram accounts. Making clips works without it.</p>
          <div className={styles.fields}>
            <Field label="App ID">
              <input name="metaAppId" defaultValue={settings.metaAppId ?? ""} inputMode="numeric" autoComplete="off" />
            </Field>
            <Field
              label="App secret"
              hint={settings.metaAppSecret ? "Saved. Type a new one to replace it." : "Not saved yet."}
            >
              <input name="metaAppSecret" type="password" autoComplete="new-password" placeholder={settings.metaAppSecret ? "Saved" : ""} />
            </Field>
          </div>
        </Card>

        <Card>
          <h2>Failure emails</h2>
          <p className={styles.note}>
            An email each morning when a post failed or an account needs reconnecting, sent through{" "}
            <a href="https://resend.com">Resend</a>. Leave the address empty to turn them off.
          </p>
          <div className={styles.fields}>
            <Field label="Your email address" hint="Also shown as the contact on the privacy page.">
              <input name="alertEmail" type="email" defaultValue={settings.alertEmail ?? ""} autoComplete="email" />
            </Field>
            <Field
              label="Resend API key"
              hint={settings.resendApiKey ? "Saved. Type a new one to replace it." : "Starts with re_."}
            >
              <input name="resendApiKey" type="password" autoComplete="new-password" placeholder={settings.resendApiKey ? "Saved" : ""} />
            </Field>
            <Field label="Sender" hint="Keep Localirs <onboarding@resend.dev> unless you verified your own domain in Resend.">
              <input name="emailFrom" defaultValue={settings.emailFrom ?? ""} placeholder="Localirs <onboarding@resend.dev>" />
            </Field>
          </div>
        </Card>

        <Card>
          <h2>Captions</h2>
          <div className={styles.fields}>
            <Field label="Caption language" hint="The language spoken in your videos. Auto-detect works for most.">
              <select name="captionLanguage" defaultValue={settings.captionLanguage}>
                {CAPTION_LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Card>

        <div>
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save settings
          </SubmitButton>
        </div>
      </ActionForm>

      <h2>Data folder and logs</h2>
      <Card>
        <dl className={styles.facts}>
          <dt>App folder</dt>
          <dd>
            <code>{appFolder}</code>
          </dd>
          {installed ? (
            <>
              <dt>Data folder</dt>
              <dd>
                <code>{dataFolder}</code>
                <p className={styles.note}>
                  The database is in <code>postgres</code>, the videos and clips in <code>seaweedfs</code>. Back up this
                  whole folder to keep everything.
                </p>
              </dd>
              <dt>Logs</dt>
              <dd>
                In the data folder: <code>{LOG_FILES.join(", ")}</code>
              </dd>
            </>
          ) : (
            <>
              <dt>Data folder</dt>
              <dd>
                This copy is not an installed one, so there is no data folder next to the app folder. The database and
                file storage are the ones set in the app folder&apos;s <code>.env</code>, and the logs are in the
                terminal that runs it.
              </dd>
            </>
          )}
        </dl>
      </Card>
    </main>
  );
}
