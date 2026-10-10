// One-off: run once after moving from BullMQ to pg-boss, so posts scheduled before the move publish again.
import { prisma } from "../src/lib/prisma";
import { requeueUnqueuedPosts } from "../src/lib/scheduling";
import { getBoss, getPublishQueue } from "../src/lib/queues";

async function main() {
  const count = await requeueUnqueuedPosts(prisma, getPublishQueue(), new Date());
  console.log(`queued ${count} scheduled post(s) that had no job`);
  await (await getBoss()).stop();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
