import type { Metadata } from "next";
import { connection } from "next/server";
import { PageHeader } from "@/components/page-header";
import { getOwnerId } from "@/lib/owner";
import { prisma } from "@/lib/prisma";
import { listQueue } from "@/lib/work-queue";
import { QueueView } from "./queue-view";

export const metadata: Metadata = { title: "Queue" };

export default async function QueuePage() {
  await connection();
  const listing = await listQueue({ db: prisma, ownerId: await getOwnerId(), now: new Date() });
  return (
    <main>
      <PageHeader
        title="Queue"
        description="What is running or waiting: clips being made, AI videos, and posts publishing within the hour."
      />
      <QueueView initial={listing} />
    </main>
  );
}
