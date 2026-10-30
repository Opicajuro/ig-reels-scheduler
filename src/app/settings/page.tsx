import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { connection } from "next/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Alert } from "@/components/alert";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { ExternalLink } from "@/components/platform-links";
import { StatusBadge } from "@/components/status-badge";
import { AI_ENGINE, aiDir, downloadBytes, formatGigabytes, getAiEngine, requiredFreeBytes } from "@/lib/ai-engine";
import { checkGpu, formatVram } from "@/lib/ai-gpu";
import { getOwnerId } from "@/lib/owner";
import { platformName } from "@/lib/platforms";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import {
  addGuideLinkAction,
  addProfileLinkAction,
  removeGuideLinkAction,
  removeProfileLinkAction,
  saveSettingsAction,
} from "./actions";
import { installAiEngineAction, uninstallAiEngineAction } from "./ai-actions";
import { AppearanceSection } from "./appearance-section";
import { EncoderSection } from "./encoder-section";
import { EngineProgress } from "./engine-progress";
import { R2Section } from "./r2-section";
import { BackupsSection } from "./backups-section";
import styles from "./settings.module.css";

export const metadata: Metadata = { title: "Settings" };

// The log files the installed app writes to its data folder (installer/services.ps1 and the setup scripts).
const LOG_FILES = ["web.log", "web.err.log", "worker.log", "worker.err.log", "start.log", "setup.log", "postgres.log"];

export default async function SettingsPage() {
  await connection();
  const settings = await getSettings(prisma);
  const ownerId = await getOwnerId();
  const [profiles, guides] = await Promise.all([
    prisma.profileLink.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } }),
    prisma.guideLink.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } }),
  ]);
  // An installed copy runs from <install>\app and keeps its database, videos and logs in <install>\data.
  const appFolder = process.cwd();
  const dataFolder = path.resolve(appFolder, "..", "data");
  const installed = existsSync(dataFolder);

  // The secrets are never put in the page: their fields start empty and say whether one is saved.
  return (
    <main>
      <PageHeader title="Settings" description="Changes take effect as soon as they are saved, without a restart." />
      <AppearanceSection />
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

        <div>
          <SubmitButton variant="primary" pendingLabel="Saving…">
            Save settings
          </SubmitButton>
        </div>
      </ActionForm>

      <h2>Links</h2>
      <div className={styles.cards}>
        <Card>
          <div className={styles.stack}>
            <h2 id="profiles">Your profiles</h2>
            <p className={styles.note}>Links to your channels and pages on other sites, shown on Home and the privacy page.</p>
            {profiles.length === 0 ? (
              <EmptyState>No profiles yet.</EmptyState>
            ) : (
              <ul className={styles.links}>
                {profiles.map((profile) => (
                  <li key={profile.id}>
                    <strong>{platformName(profile.url)}</strong>
                    <ExternalLink href={profile.url} className={styles.linkUrl}>
                      {profile.url}
                    </ExternalLink>
                    <ActionForm action={removeProfileLinkAction}>
                      <input type="hidden" name="linkId" value={profile.id} />
                      <SubmitButton size="sm" pendingLabel="Removing…">
                        Remove
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={addProfileLinkAction} className={styles.addLink}>
              <Field label="Profile link" hint="Such as your YouTube channel, TikTok or Facebook page.">
                <input type="url" name="url" maxLength={2000} placeholder="https://…" required />
              </Field>
              <SubmitButton pendingLabel="Adding…">Add profile</SubmitButton>
            </ActionForm>
          </div>
        </Card>

        <Card>
          <div className={styles.stack}>
            <h2 id="guides">Video guides</h2>
            <p className={styles.note}>Videos that show how to use Localirs, listed on the Help page.</p>
            {guides.length === 0 ? (
              <EmptyState>No video guides yet.</EmptyState>
            ) : (
              <ul className={styles.links}>
                {guides.map((guide) => (
                  <li key={guide.id}>
                    <strong>{guide.title}</strong>
                    <ExternalLink href={guide.url} className={styles.linkUrl}>
                      {guide.url}
                    </ExternalLink>
                    <ActionForm action={removeGuideLinkAction}>
                      <input type="hidden" name="linkId" value={guide.id} />
                      <SubmitButton size="sm" pendingLabel="Removing…">
                        Remove
                      </SubmitButton>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            <ActionForm action={addGuideLinkAction} className={styles.addLink}>
              <div className={styles.fields}>
                <Field label="Title">
                  <input name="title" maxLength={120} required />
                </Field>
                <Field label="Video link">
                  <input type="url" name="url" maxLength={2000} placeholder="https://…" required />
                </Field>
              </div>
              <SubmitButton pendingLabel="Adding…">Add guide</SubmitButton>
            </ActionForm>
          </div>
        </Card>
      </div>

      <EncoderSection />

      <R2Section />

      <h2 id="ai-video">AI video</h2>
      <AiVideoSection />

      <BackupsSection />

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

// This PC's graphics card and, when it can make AI videos, the engine that makes them. The Clips page has the form.
async function AiVideoSection() {
  const gpu = await checkGpu();
  const ready = gpu.found && gpu.ready;

  return (
    <div className={styles.cards}>
      <Card>
        <div className={styles.stack}>
          <h2>This PC</h2>
          {gpu.found ? (
            <>
              <dl className={styles.facts}>
                <dt>Graphics card</dt>
                <dd>{gpu.gpu.name}</dd>
                <dt>Video memory</dt>
                <dd>{formatVram(gpu.gpu.vramMiB)}</dd>
                <dt>Driver</dt>
                <dd>{gpu.gpu.driver}</dd>
              </dl>
              {!gpu.ready ? (
                <Alert tone="error">This card has too little video memory for AI videos. They need at least 12 GB.</Alert>
              ) : gpu.recommended ? (
                <p className={styles.ok}>Ready for AI videos.</p>
              ) : (
                <p className={styles.warning}>Ready, but 16 GB of video memory is recommended: videos take longer on this card.</p>
              )}
            </>
          ) : (
            <Alert tone="error">{gpu.reason}</Alert>
          )}
          {ready ? null : (
            <p className={styles.note}>
              AI videos are made on this PC by an NVIDIA graphics card with at least 12 GB of video memory (16 GB
              recommended), such as a GeForce RTX 4070 Ti Super, 4080 or 5080. Without one, there is nothing to set up.
            </p>
          )}
        </div>
      </Card>
      {ready ? <AiEngineCard /> : null}
    </div>
  );
}

async function AiEngineCard() {
  const engine = await getAiEngine(prisma);
  let dir: string | null = null;
  let dirProblem: string | null = null;
  try {
    dir = aiDir();
  } catch (err) {
    dirProblem = (err as Error).message;
  }

  return (
    <Card>
      <div className={styles.stack}>
        <div className={styles.heading}>
          <h2>AI video engine</h2>
          <StatusBadge status={engine.status} />
        </div>
        <p className={styles.note}>
          ComfyUI {AI_ENGINE.comfyui.version} (GPL-3.0) with the Wan 2.2 TI2V 5B video model (Apache-2.0), downloaded
          once into {dir ?? "the data folder"}.
        </p>
        {dirProblem ? <Alert tone="error">{dirProblem}</Alert> : null}
        {engine.status === "installing" ? <EngineProgress initialStep={engine.step} initialPercent={engine.percent} /> : null}
        {engine.status === "installed" && engine.installedBytes !== null ? (
          <div className={styles.row}>
            <span>Installed, {formatGigabytes(engine.installedBytes)} on disk. New AI videos are made on the Clips page.</span>
            <ActionForm
              action={uninstallAiEngineAction}
              confirm={{
                message: `Delete the AI video engine (${formatGigabytes(engine.installedBytes)}) from this PC? The AI videos already made stay in your clips.`,
                confirmLabel: "Uninstall",
              }}
            >
              <SubmitButton variant="danger" pendingLabel="Uninstalling…">
                Uninstall
              </SubmitButton>
            </ActionForm>
          </div>
        ) : null}
        {engine.status === "failed" ? <Alert tone="error">The install stopped: {engine.error}</Alert> : null}
        {(engine.status === "not_installed" || engine.status === "failed") && dir ? (
          <div className={styles.row}>
            <span>
              Downloads {formatGigabytes(downloadBytes(AI_ENGINE))} and needs {formatGigabytes(requiredFreeBytes(AI_ENGINE))} of free disk space.
              {engine.status === "failed" ? " Files already downloaded are kept." : ""}
            </span>
            <ActionForm action={installAiEngineAction}>
              <SubmitButton variant="primary" pendingLabel="Starting…">
                {engine.status === "failed" ? "Try again" : "Install"}
              </SubmitButton>
            </ActionForm>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
