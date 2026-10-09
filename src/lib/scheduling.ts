const LEAD_TIME_MS = 45 * 60 * 1000;

export type PublishQueue = {
  add(name: string, data: { postId: string }, opts: { jobId: string; delay: number }): Promise<unknown>;
  remove(jobId: string): Promise<unknown>;
};

export async function schedulePost(queue: PublishQueue, post: { id: string; scheduledAt: Date }, now: Date) {
  const delay = Math.max(0, post.scheduledAt.getTime() - now.getTime() - LEAD_TIME_MS);
  await queue.add("publish", { postId: post.id }, { jobId: post.id, delay });
}

export async function cancelPost(queue: PublishQueue, postId: string) {
  await queue.remove(postId);
}
