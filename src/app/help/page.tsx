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
import { ReportProblemButton } from "./report-problem";

export const metadata: Metadata = { title: "Help" };

const META_DOCS = "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login";
const META_HOME = "https://developers.facebook.com/";
const META_APPS = "https://developers.facebook.com/apps/";
const GOOGLE_NEW_PROJECT = "https://console.cloud.google.com/projectcreate";
const YOUTUBE_API_LIBRARY = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
const GOOGLE_AUTH_PLATFORM = "https://console.cloud.google.com/auth/overview";
const GOOGLE_CONSENT_DOCS = "https://developers.google.com/workspace/guides/configure-oauth-consent";
const GOOGLE_CREDENTIALS_DOCS = "https://developers.google.com/workspace/guides/create-credentials#oauth-client-id";
const YOUTUBE_GETTING_STARTED = "https://developers.google.com/youtube/v3/getting-started";
const YOUTUBE_QUOTA = "https://developers.google.com/youtube/v3/getting-started#quota";
const YOUTUBE_INSERT_DOCS = "https://developers.google.com/youtube/v3/docs/videos/insert";
const GOOGLE_TOKEN_EXPIRY = "https://developers.google.com/identity/protocols/oauth2#expiration";
const YOUTUBE_SYNTHETIC = "https://blog.youtube/inside-youtube/our-approach-to-responsible-ai-innovation/";
const GOOGLE_PERMISSIONS = "https://myaccount.google.com/connections";
const FB_LOGIN_BUSINESS = "https://developers.facebook.com/docs/facebook-login/facebook-login-for-business";
const FB_ACCESS_LEVELS = "https://developers.facebook.com/docs/graph-api/overview/access-levels";
const FB_REELS_DOCS = "https://developers.facebook.com/docs/video-api/guides/reels-publishing";
const FB_REELS_REFERENCE = "https://developers.facebook.com/docs/graph-api/reference/page/video_reels/";
const FB_LONG_LIVED = "https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived";
const TIKTOK_DEVELOPERS = "https://developers.tiktok.com/apps/";
const TIKTOK_POSTING_DOCS = "https://developers.tiktok.com/doc/content-posting-api-get-started";
const TIKTOK_UPLOAD_DOCS = "https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content";
const TIKTOK_UPLOAD_REFERENCE = "https://developers.tiktok.com/doc/content-posting-api-reference-upload-video";
const TIKTOK_MEDIA_TRANSFER = "https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide";
const TIKTOK_LOGIN_DESKTOP = "https://developers.tiktok.com/doc/login-kit-desktop/";
const TIKTOK_SANDBOX = "https://developers.tiktok.com/doc/add-a-sandbox/";
const LATEST_RELEASE = "https://github.com/Opicajuro/ig-reels-scheduler/releases/latest";

// Short guides in plain words, and the video guides the owner added in Settings.
export default async function HelpPage() {
  await connection();
  const guides = await prisma.guideLink.findMany({ where: { ownerId: await getOwnerId() }, orderBy: { createdAt: "asc" } });

  return (
    <main className={styles.page}>
      <PageHeader title="Help" description="How to make clips, connect Instagram, YouTube, Facebook and TikTok, make AI videos and keep Localirs up to date." />

      <nav className={styles.contents} aria-label="On this page">
        <a href="#videos">Video guides</a>
        <a href="#start">Getting started</a>
        <a href="#instagram">Connecting Instagram</a>
        <a href="#youtube">Connecting YouTube</a>
        <a href="#facebook">Connecting Facebook Pages</a>
        <a href="#tiktok">TikTok drafts</a>
        <a href="#ai">AI video</a>
        <a href="#update">Updating Localirs</a>
        <a href="#logs">Logs</a>
        <a href="#report">Report a problem</a>
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
            To schedule, open a clip and use its <strong>Schedule</strong> tab, or select several clips and press{" "}
            <strong>Schedule…</strong> to space them out. Tick the Instagram accounts and YouTube channels each clip goes
            to. Your posts are listed under{" "}
            <Link href="/scheduled">Scheduled</Link>. Localirs must be running at the publish time.
          </li>
          <li>
            Once posts are out, <Link href="/stats">Stats</Link> compares them by clip length, caption style, source and posting
            time, and lists your best weekday and hour to post. <strong>Use best time</strong> next to the publish time
            fills in the next of those slots.
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
            Log in at <ExternalLink href={META_HOME}>Meta for Developers</ExternalLink> with your Facebook account
            (Login, top right). The first time, Meta asks you to register as a developer: confirm your phone or email and
            accept the terms. The app dashboard only opens once you are logged in.
          </li>
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

      <section id="youtube">
        <h2>Connecting YouTube</h2>
        <p>
          Localirs uploads Shorts through your own <strong>Google Cloud OAuth client</strong>, so the upload quota and the
          sign-in screen are yours. It is free. You need a Google account with a YouTube channel.
        </p>
        <ol>
          <li>
            <ExternalLink href={GOOGLE_NEW_PROJECT}>Create a Google Cloud project</ExternalLink>, for example{" "}
            <code>localirs</code>.
          </li>
          <li>
            In that project, open the <ExternalLink href={YOUTUBE_API_LIBRARY}>YouTube Data API v3</ExternalLink> and
            press <strong>Enable</strong>.
          </li>
          <li>
            Set up the OAuth consent screen in the{" "}
            <ExternalLink href={GOOGLE_AUTH_PLATFORM}>Google Auth Platform</ExternalLink> (Google&apos;s guide:{" "}
            <ExternalLink href={GOOGLE_CONSENT_DOCS}>Configure the OAuth consent screen</ExternalLink>): give it a name and
            your email, choose the <strong>External</strong> audience, leave the publishing status on{" "}
            <strong>Testing</strong>, and under <strong>Audience</strong> add your own Google account as a{" "}
            <strong>test user</strong>.
          </li>
          <li>
            Under <strong>Clients</strong>, create an OAuth client (Google&apos;s guide:{" "}
            <ExternalLink href={GOOGLE_CREDENTIALS_DOCS}>Create credentials</ExternalLink>). Choose{" "}
            <strong>Web application</strong> and add this address as an authorized redirect URI:{" "}
            <code>{new URL("/api/youtube/callback", requireEnv("APP_URL")).toString()}</code>. A{" "}
            <strong>Desktop app</strong> client works too.
          </li>
          <li>
            Copy the client ID and client secret into <strong>YouTube</strong> on the <Link href="/settings">Settings</Link>{" "}
            page and save.
          </li>
          <li>
            On <Link href="/accounts">Accounts</Link>, press <strong>Connect YouTube</strong>, sign in with the test
            user, choose the channel and allow everything Localirs asks for: uploading videos and seeing your channel and
            its view counts. If Google warns that the app is not verified, that is your own app: continue.
          </li>
        </ol>
        <p>Good to know, from Google&apos;s documentation as of November 2026:</p>
        <ul>
          <li>
            <strong>Quota.</strong> A project gets 100 uploads (<code>videos.insert</code> calls) a day by default, in
            their own quota, and 10,000 units a day for everything else; a view-count check costs 1 unit (
            <ExternalLink href={YOUTUBE_QUOTA}>YouTube Data API quota</ExternalLink>). Older guides say an upload costs
            about 1,600 of the 10,000 units, about 6 uploads a day: that was the rule until December 2025. Quotas reset at
            midnight Pacific time. When the quota is used up, the post fails with a message that says so, and{" "}
            <strong>Retry</strong> works after the reset.
          </li>
          <li>
            <strong>Unverified apps.</strong> Google&apos;s{" "}
            <ExternalLink href={YOUTUBE_INSERT_DOCS}>videos.insert reference</ExternalLink> now says &ldquo;Videos uploaded
            from unverified API projects are not restricted to private viewing mode.&rdquo; Earlier versions said uploads
            from unverified projects created after 28 July 2020 were locked private until the project passed Google&apos;s
            audit, and older guides still repeat that. Some uploads can still start private because of your channel&apos;s own settings.
          </li>
          <li>
            <strong>Weekly reconnect while in Testing.</strong> Google gives an app in Testing a login that{" "}
            <ExternalLink href={GOOGLE_TOKEN_EXPIRY}>expires after 7 days</ExternalLink>. The channel then shows{" "}
            <strong>Needs reconnecting</strong> on Accounts; press <strong>Reconnect</strong>. Publishing the consent
            screen (In production) avoids this, at the cost of Google&apos;s unverified-app warning at each sign-in.
          </li>
          <li>
            <strong>Shorts.</strong> A Short is vertical or square and at most 3 minutes long. Localirs clips are
            vertical, and longer clips are refused when you schedule. The title is up to 100 characters (the clip&apos;s
            title), the description is the caption with <code>#Shorts</code> added (up to 5,000 bytes). YouTube requires
            you to say whether a video is made for kids; the answer starts on No.
          </li>
          <li>
            <strong>AI content.</strong> A clip made with AI, or one you tick as AI-generated, is uploaded with YouTube&apos;s{" "}
            <ExternalLink href={YOUTUBE_SYNTHETIC}>altered or synthetic content</ExternalLink> disclosure set (the API&apos;s{" "}
            <code>status.containsSyntheticMedia</code>). YouTube asks for it on realistic content: a real person saying or
            doing something they did not, altered footage of a real event or place, or a realistic scene that never
            happened.
          </li>
          <li>
            Views, likes and comments are read 1 hour, 24 hours and 7 days after the upload and shown on the post&apos;s
            page. Disconnecting a channel makes Localirs forget its login; remove the access itself under{" "}
            <ExternalLink href={GOOGLE_PERMISSIONS}>Third-party connections</ExternalLink> in your Google Account. More in{" "}
            <ExternalLink href={YOUTUBE_GETTING_STARTED}>Google&apos;s YouTube Data API overview</ExternalLink>.
          </li>
        </ul>
      </section>

      <section id="facebook">
        <h2>Connecting Facebook Pages</h2>
        <p>
          Localirs publishes Reels to a Facebook Page through the same Meta app as Instagram. Instagram Login, which
          connects the Instagram accounts, gives no access to Facebook Pages, so the app needs a second product:{" "}
          <ExternalLink href={FB_LOGIN_BUSINESS}>Facebook Login for Business</ExternalLink>. You need a Page on which your
          Facebook account can create content.
        </p>
        <ol>
          <li>
            Open your app on the <ExternalLink href={META_APPS}>Meta app dashboard</ExternalLink> and add the{" "}
            <strong>Facebook Login for Business</strong> product, if it is not there yet. Meta offers it to Business type
            apps and to apps with a use case that supports it.
          </li>
          <li>
            Under <strong>Facebook Login for Business</strong>, <strong>Settings</strong>, add this address to{" "}
            <strong>Valid OAuth Redirect URIs</strong>:{" "}
            <code>{new URL("/api/facebook/callback", requireEnv("APP_URL")).toString()}</code>
          </li>
          <li>
            Under <strong>Configurations</strong>, create a configuration: choose the <strong>User access token</strong>,
            the <strong>Pages</strong> asset and the permissions <code>pages_show_list</code>,{" "}
            <code>pages_read_engagement</code> and <code>pages_manage_posts</code>, the three Meta&apos;s{" "}
            <ExternalLink href={FB_REELS_DOCS}>Reels Publishing API</ExternalLink> asks for. Copy its{" "}
            <strong>Configuration ID</strong> into <strong>Facebook Pages</strong> on the <Link href="/settings">Settings</Link>{" "}
            page and save. The app ID and secret are the ones already saved under <strong>Meta app</strong>.
          </li>
          <li>
            On <Link href="/accounts">Accounts</Link>, press <strong>Connect Facebook Page</strong>, log in, choose your
            Page and allow everything. Back in Localirs, tick the Pages to post to.
          </li>
        </ol>
        <p>Good to know, from Meta&apos;s documentation as of November 2026:</p>
        <ul>
          <li>
            <strong>No App Review for your own Pages.</strong> Meta&apos;s{" "}
            <ExternalLink href={FB_ACCESS_LEVELS}>access levels</ExternalLink>: Business apps are automatically approved
            for Standard Access to every permission, and permissions with Standard Access &ldquo;can only be requested from
            app users who have a role on the requesting app&rdquo;. So as the app&apos;s admin (or a developer or tester
            you add under App roles), you can connect your own Pages with the app still in Development mode, without App
            Review. Other people need Advanced Access, which takes App Review and Business Verification.
          </li>
          <li>
            <strong>The login lasts.</strong> Localirs keeps only the Page tokens, made from a long-lived user token, and
            Meta&apos;s <ExternalLink href={FB_LONG_LIVED}>long-lived token guide</ExternalLink> says those have no expiry
            date. They stop working if you change your Facebook password, lose your role on the Page or remove the app
            under Business Integrations in Facebook&apos;s settings; the Page then shows <strong>Needs reconnecting</strong>.
          </li>
          <li>
            <strong>Reels.</strong> A Reel is 3 to 90 seconds long, 9:16, at least 540&times;960 and 24 to 60 frames a
            second; Localirs clips are 1080&times;1920, and clips outside 3 to 90 seconds are refused when you schedule. A
            Page can publish 30 Reels through the API in 24 hours; past that the post fails with a message that says so.
            The caption becomes the Reel&apos;s description.
          </li>
          <li>
            <strong>How the video gets there.</strong> With Cloudflare R2 set up, Facebook downloads the video from a
            one-hour R2 link, as Instagram does (the API&apos;s <code>file_url</code>); without R2, Localirs uploads the
            file from this PC. Either way the upload, Facebook&apos;s processing and the publishing are checked until the
            Reel is live, and its link is shown on Scheduled and on the post&apos;s page.
          </li>
          <li>
            <strong>AI content.</strong> A clip made with AI, or one you tick as AI-generated, is published with the Reels
            API&apos;s <code>is_ai_generated</code> flag (&ldquo;a boolean flag for developers to self-claim whether the
            video was created with AI&rdquo;, in the <ExternalLink href={FB_REELS_REFERENCE}>video_reels reference</ExternalLink>).
          </li>
        </ul>
      </section>

      <section id="tiktok">
        <h2>TikTok drafts</h2>
        <p>
          Localirs sends clips to your TikTok inbox as drafts, with TikTok&apos;s{" "}
          <ExternalLink href={TIKTOK_UPLOAD_DOCS}>Content Posting API upload</ExternalLink>. At the publish time TikTok
          notifies you in the TikTok app; open the notification, add the caption (shown on the post&apos;s page in
          Localirs) and post it. It goes through your own TikTok developer app.
        </p>
        <ol>
          <li>
            Log in at <ExternalLink href={TIKTOK_DEVELOPERS}>TikTok for Developers</ExternalLink> and create an app.
          </li>
          <li>
            Add the <strong>Login Kit</strong> and <strong>Content Posting API</strong> products, and the scopes{" "}
            <code>user.info.basic</code> and <code>video.upload</code>. Leave Direct Post off: Localirs only sends drafts.
          </li>
          <li>
            In Login Kit, choose the <strong>Desktop</strong> platform, which accepts a <code>http://localhost</code>{" "}
            address (<ExternalLink href={TIKTOK_LOGIN_DESKTOP}>Login Kit for Desktop</ExternalLink>), and add this redirect
            URI exactly: <code>{new URL("/api/tiktok/callback", requireEnv("APP_URL")).toString()}</code>
          </li>
          <li>
            Copy the app&apos;s <strong>client key</strong> and <strong>client secret</strong> into <strong>TikTok</strong>{" "}
            on the <Link href="/settings">Settings</Link> page and save.
          </li>
          <li>
            On <Link href="/accounts">Accounts</Link>, press <strong>Connect TikTok</strong>, log in and allow both
            permissions.
          </li>
        </ol>
        <p>Good to know, from TikTok&apos;s documentation as of November 2026:</p>
        <ul>
          <li>
            <strong>Review and audit.</strong> The upload guide&apos;s prerequisites are that &ldquo;your app must be
            approved for the <code>video.upload</code> scope&rdquo; and that the user authorized it. Until TikTok approves
            the app, use its <ExternalLink href={TIKTOK_SANDBOX}>Sandbox</ExternalLink> and add your TikTok account as a
            target user. The separate content-sharing audit is about{" "}
            <ExternalLink href={TIKTOK_POSTING_DOCS}>Direct Post</ExternalLink>, where &ldquo;all content posted by unaudited
            clients will be restricted to private viewing mode&rdquo;; a draft is posted by you in the TikTok app, where you
            choose who can see it. If TikTok still answers with an unaudited-app limit (only private accounts, or at most 5
            accounts a day), the post fails with that message in plain words.
          </li>
          <li>
            <strong>At most 5 drafts waiting.</strong> The{" "}
            <ExternalLink href={TIKTOK_UPLOAD_REFERENCE}>upload reference</ExternalLink>: &ldquo;There may be at most 5
            pending shares within any 24-hour period.&rdquo; Post or delete drafts in the app before sending more; past the
            limit the post fails and <strong>Retry</strong> works later.
          </li>
          <li>
            <strong>Upload.</strong> The video is sent from this PC in chunks of 10&nbsp;MB, by the{" "}
            <ExternalLink href={TIKTOK_MEDIA_TRANSFER}>Media Transfer Guide</ExternalLink>&apos;s rules (5 to 64&nbsp;MB, the
            last chunk takes the rest, up to 128&nbsp;MB). Uploading from a link would need a domain verified with TikTok,
            so Localirs does not use it. An interrupted upload goes on from the chunks TikTok has.
          </li>
          <li>
            <strong>AI content.</strong> TikTok&apos;s draft upload has no AI setting. For a clip made with AI, turn on
            TikTok&apos;s AI-generated content label when you post the draft; Localirs reminds you on the post&apos;s page.
          </li>
          <li>
            <strong>Login.</strong> TikTok&apos;s access token lasts a day and Localirs renews it; the renewal token lasts a
            year, after which the account shows <strong>Needs reconnecting</strong>. Remove the access under{" "}
            <strong>Manage app permissions</strong> in the TikTok app.
          </li>
        </ul>
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

      <section id="report">
        <h2>Report a problem</h2>
        <p>
          Makes a ZIP in <code>data\reports</code> with the end of each log, the version and a short summary of this PC,
          then opens that folder. Send the ZIP to whoever helps you. It holds no passwords, tokens or keys.
        </p>
        <ReportProblemButton />
      </section>
    </main>
  );
}
