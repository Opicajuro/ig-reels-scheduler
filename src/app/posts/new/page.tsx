import { Suspense } from "react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createScheduledPost } from "@/lib/posts";
import { getPublishQueue } from "@/lib/queues";
import { PublishAtInput } from "./publish-at-input";

async function PostEditor() {
  await connection();
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const accounts = await prisma.igAccount.findMany({
    where: { ownerId: session.user.id, status: "active" },
    orderBy: { createdAt: "asc" },
  });
  const media = await prisma.media.findMany({
    where: { status: "ready", account: { ownerId: session.user.id } },
    orderBy: { id: "asc" },
  });

  async function schedule(formData: FormData) {
    "use server";
    const current = await auth();
    if (!current?.user?.id) redirect("/login");
    await createScheduledPost({
      db: prisma,
      queue: getPublishQueue(),
      ownerId: current.user.id,
      input: {
        accountId: String(formData.get("accountId")),
        mediaId: String(formData.get("mediaId")),
        caption: String(formData.get("caption")),
        scheduledAt: String(formData.get("scheduledAt")),
        shareToFeed: formData.get("shareToFeed") === "on",
      },
      now: new Date(),
    });
    redirect("/posts/new");
  }

  return (
    <main>
      <h1>Schedule a Reel</h1>
      {accounts.length === 0 || media.length === 0 ? (
        <p>Connect an account and finish processing a video first.</p>
      ) : (
        <form action={schedule}>
          <label>
            Account
            <select name="accountId" required>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  @{account.username}
                </option>
              ))}
            </select>
          </label>
          <label>
            Video
            <select name="mediaId" required>
              {media.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Caption
            <textarea name="caption" maxLength={2200} required />
          </label>
          <PublishAtInput />
          <label>
            <input name="shareToFeed" type="checkbox" defaultChecked /> Also share to feed
          </label>
          <button type="submit">Schedule</button>
        </form>
      )}
    </main>
  );
}

export default function PostsNewPage() {
  return (
    <Suspense fallback={<main>Loading…</main>}>
      <PostEditor />
    </Suspense>
  );
}
