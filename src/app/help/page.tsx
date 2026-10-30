import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ExternalLink } from "@/components/platform-links";
import { requireEnv } from "@/lib/env";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import styles from "./help.module.css";

export const metadata: Metadata = { title: "Help" };

const META_DOCS = "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login";
const META_APPS = "https://developers.facebook.com/apps/";
const LATEST_RELEASE = "https://github.com/Opicajuro/ig-reels-scheduler/releases/latest";

// Short guides in plain words, and the video guides the owner added in Settings.
export default async function HelpPage() {
  await connection();
  const guides = await prisma.guideLink.findMany({ where: { ownerId: await getOwnerId() }, orderBy: { createdAt: "asc" } });

  return (
    <main className={styles.page}>
      <PageHeader title="Help" description="How to make clips, connect Instagram, make AI videos and keep Localirs up to date." />

      <nav className={styles.contents} aria-label="On this page">
        <a href="#videos">Video guides</a>
        <a href="#start">Getting started</a>
        <a href="#instagram">Connecting Instagram</a>
        <a href="#ai">AI video</a>
        <a href="#update">Updating Localirs</a>
        <a href="#logs">Logs</a>
      </nav>

      <section id="videos">
        <h2>Video guides</h2>
        {guides.length === 0 ? (
          <EmptyState>
            No video guides yet. Add them under Video guides on the <Link href="/settings#guides">Settings</Link> page.
          </EmptyState>
        ) : (
          <Card>
            <ul className={styles.guides}>
              {guides.map((guide) => (
                <li key={guide.id}>
                  <ExternalLink href={guide.url} title={guide.url}>
                    {guide.title}
                  </ExternalLink>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section id="start">
        <h2>Getting started</h2>
        <ol>
          <li>
            Open <Link href="/clips">Clips</Link>. Upload a video file from this PC, or paste a link to a video (such as
            a YouTube video) and give the project a name.
          </li>
          <li>
            On the project, pick how long each clip should be and how many you want (Auto makes as many as the video
            allows), then press <strong>Make clips</strong>. It takes a few minutes; you can leave the page open or come
            back later.
          </li>
          <li>
            To put words on the video, tick <strong>Burn in captions</strong> before making clips and pick a style.{" "}
            <strong>Word by word</strong> lights up each word as it is spoken. You can also put the captions at the top,
            middle or bottom, and in all capitals.
          </li>
          <li>
            Press <strong>Open</strong> on a clip to give it a title and a description (with hashtags). The description
            is what Instagram shows as the caption.
          </li>
          <li>
            To schedule, open a clip and use its <strong>Instagram</strong> tab, or select several clips and press{" "}
            <strong>Schedule on Instagram</strong> to space them out. Your posts are listed under{" "}
            <Link href="/scheduled">Scheduled</Link>. Localirs must be running at the publish time.
          </li>
          <li>
            Posted a clip somewhere else too, such as YouTube Shorts or TikTok? Open it and add the link on its{" "}
            <strong>Links</strong> tab, so you can find it again from here.
          </li>
        </ol>
      </section>

      <section id="instagram">
        <h2>Connecting Instagram</h2>
        <p>
          Localirs posts to Instagram through your own <strong>Meta app</strong>: a free app you create on Meta&apos;s
          developer site, which lets Localirs post for you. It has two values you copy into Localirs:
        </p>
        <ul>
          <li>
            <strong>App ID</strong>: the app&apos;s number. It is not secret.
          </li>
          <li>
            <strong>App secret</strong>: the app&apos;s password. Keep it to yourself; Localirs stores it encrypted.
          </li>
        </ul>
        <ol>
          <li>
            Create an app on the <ExternalLink href={META_APPS}>Meta app dashboard</ExternalLink> and add Instagram to
            it, following Meta&apos;s guide{" "}
            <ExternalLink href={META_DOCS}>Instagram API with Instagram Login</ExternalLink>. Your Instagram account must
            be a Business or Creator account.
          </li>
          <li>
            In the app&apos;s Instagram settings, add this address as the OAuth redirect URL:{" "}
            <code>{requireEnv("IG_REDIRECT_URI")}</code>
          </li>
          <li>
            Copy the Instagram app ID and app secret into <strong>Meta app</strong> on the{" "}
            <Link href="/settings">Settings</Link> page and save.
          </li>
          <li>
            Go to <Link href="/accounts">Accounts</Link> and connect your Instagram account.
          </li>
        </ol>
      </section>

      <section id="ai">
        <h2>AI video</h2>
        <p>
          Localirs can make a short video from a written description, on this PC and without the internet. It needs an
          NVIDIA graphics card with at least 12 GB of video memory (16 GB is faster).
        </p>
        <ol>
          <li>
            Under AI video on the <Link href="/settings#ai-video">Settings</Link> page, check that your graphics card is
            ready and press <strong>Install</strong>. It downloads the AI video engine once, which takes a while.
          </li>
          <li>
            Then on <Link href="/clips">Clips</Link>, choose <strong>From a description (AI)</strong>, describe the video
            and make it. It lands in your AI videos project, ready to schedule like any clip.
          </li>
        </ol>
      </section>

      <section id="update">
        <h2>Updating Localirs</h2>
        <p>
          Localirs looks for a new version when it starts. You can also right-click its tray icon (next to the clock) and
          choose <strong>Check for updates</strong>. When one is ready, choose <strong>Install update</strong>: Localirs
          closes, updates itself in a minute or two, and opens again.
        </p>
        <p>
          Or update by hand: download the newest <code>Localirs-Setup.exe</code> from{" "}
          <ExternalLink href={LATEST_RELEASE}>the latest release on GitHub</ExternalLink> and run it over your install.
          Your clips, posts and settings are kept either way.
        </p>
      </section>

      <section id="logs">
        <h2>Where the logs are</h2>
        <p>
          When something goes wrong, the logs say why. Right-click the tray icon and choose{" "}
          <strong>Open logs folder</strong>: they are the <code>.log</code> files in Localirs&apos; <code>data</code>{" "}
          folder (<code>data\*.log</code>). The <Link href="/settings">Settings</Link> page shows where that folder is.
        </p>
      </section>
    </main>
  );
}
