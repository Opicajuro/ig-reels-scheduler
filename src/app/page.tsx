import Link from "next/link";
import { connection } from "next/server";
import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { LocalTime } from "@/components/local-time";
import { PageHeader } from "@/components/page-header";
import { PostList } from "@/components/post-list";
import { StatusBadge } from "@/components/status-badge";
import { metaAppConfig } from "@/lib/ig-connect";
import { describePostError } from "@/lib/meta-errors";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import styles from "./home.module.css";

const NEXT_POSTS = 5;
const RECENT_PROJECTS = 5;

// The start screen: what goes out next, what needs fixing, and the latest clip projects.
export default async function Home() {
  await connection();
  const ownerId = await getOwnerId();
  const now = new Date();

  const [upcoming, failed, accounts, projects, settings] = await Promise.all([
    prisma.post.findMany({
      where: { status: { in: ["scheduled", "container_created"] }, account: { ownerId } },
      orderBy: { scheduledAt: "asc" },
      take: NEXT_POSTS,
      include: { account: { select: { username: true } } },
    }),
    prisma.post.findMany({
      where: { status: "failed", account: { ownerId } },
      orderBy: { scheduledAt: "desc" },
      include: {
        account: { select: { username: true } },
        attemptLogs: { where: { errorCode: { not: null } }, orderBy: { at: "desc" }, take: 1 },
      },
    }),
    prisma.igAccount.findMany({ where: { ownerId, status: { not: "revoked" } }, include: { token: true } }),
    prisma.clipProject.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" }, take: RECENT_PROJECTS }),
    getSettings(prisma),
  ]);

  const metaReady = metaAppConfig(settings, process.env.IG_REDIRECT_URI) !== null;
  const reconnect = accounts.filter(
    (account) => account.status === "reauth_required" || (account.token !== null && account.token.expiresAt <= now),
  );
  const rateLimited = accounts.filter((account) => account.rateLimitedUntil && account.rateLimitedUntil > now);
  const nothingNeedsAttention = metaReady && failed.length === 0 && reconnect.length === 0 && rateLimited.length === 0;

  return (
    <main>
      <PageHeader
        title="Localirs"
        description="Cut long videos into clips and schedule them to Instagram Reels."
        actions={
          <ButtonLink href="/clips" variant="primary">
            New clips from a video
          </ButtonLink>
        }
      />

      <h2>Needs attention</h2>
      {nothingNeedsAttention ? (
        <EmptyState>Nothing needs attention.</EmptyState>
      ) : (
        <ul className={styles.attention}>
          {metaReady ? null : (
            <li>
              Instagram is not set up yet, so posts cannot be scheduled. <Link href="/settings">Add the Meta app in Settings</Link>
            </li>
          )}
          {reconnect.map((account) => (
            <li key={account.id}>
              @{account.username} needs to be reconnected before it can publish.{" "}
              {metaReady ? <a href="/api/ig/connect">Reconnect</a> : <Link href="/settings">Set up the Meta app</Link>}
            </li>
          ))}
          {rateLimited.map((account) => (
            <li key={account.id}>
              @{account.username} is paused by Instagram&apos;s rate limit until <LocalTime date={account.rateLimitedUntil!} />.
              Publishing continues after that on its own.
            </li>
          ))}
          {failed.map((post) => (
            <li key={post.id}>
              <Link href={`/posts/${post.id}`}>Post to @{post.account.username}</Link> for{" "}
              <LocalTime date={post.scheduledAt} /> failed: {describePostError(post.lastError, post.attemptLogs[0]?.errorCode ?? null)}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.columns}>
        <section>
          <h2>What&apos;s next</h2>
          {upcoming.length === 0 ? (
            <EmptyState>Nothing is scheduled. Make clips and schedule them from a project.</EmptyState>
          ) : (
            <>
              <PostList posts={upcoming} />
              <Link href="/scheduled">All scheduled posts</Link>
            </>
          )}
        </section>

        <section>
          <h2>Recent projects</h2>
          {projects.length === 0 ? (
            <EmptyState>No clip projects yet.</EmptyState>
          ) : (
            <Card>
              <ul className={styles.projects}>
                {projects.map((project) => (
                  <li key={project.id}>
                    <Link href={`/clips/${project.id}`}>{project.name}</Link>
                    <StatusBadge status={project.status} />
                    <span className={styles.muted}>
                      <LocalTime date={project.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}
