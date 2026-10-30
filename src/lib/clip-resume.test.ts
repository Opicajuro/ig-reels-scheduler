import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { parseRenderPlan, remainingClips, requeueInterruptedRenders, resumablePlan, type RenderPlan } from "./clip-resume";
import type { ClipJob, ClipJobs } from "./queues";

const plan: RenderPlan = {
  renderId: "r1",
  clips: [
    { clipId: "c1", start: 0, length: 30 },
    { clipId: "c2", start: 40, length: 30 },
    { clipId: "c3", start: 90, length: 31 },
  ],
};

describe("resumablePlan", () => {
  it("goes on with the plan this render stored", () => {
    expect(resumablePlan("r1", plan)).toEqual(plan);
  });

  it("starts over when no plan is stored yet, or the plan is from an earlier render", () => {
    expect(resumablePlan("r1", null)).toBeNull();
    expect(resumablePlan("r2", plan)).toBeNull();
  });

  it("throws on a malformed plan", () => {
    expect(() => parseRenderPlan({ renderId: "r1", clips: [{ clipId: "c1", start: "0", length: 30 }] })).toThrow("malformed");
    expect(() => parseRenderPlan({ clips: [] })).toThrow("render id");
    expect(() => parseRenderPlan("r1")).toThrow("not an object");
  });
});

describe("remainingClips", () => {
  it("leaves out the clips already saved and keeps each clip's place in the plan", () => {
    expect(remainingClips(plan, ["c1"])).toEqual([
      { index: 1, clip: plan.clips[1] },
      { index: 2, clip: plan.clips[2] },
    ]);
    expect(remainingClips(plan, ["c2"]).map(({ index }) => index)).toEqual([0, 2]);
  });

  it("is every clip when none was saved, and none when all were", () => {
    expect(remainingClips(plan, [])).toHaveLength(3);
    expect(remainingClips(plan, ["c3", "c1", "c2"])).toEqual([]);
  });

  it("throws on a saved clip that is not in the plan", () => {
    expect(() => remainingClips(plan, ["c1", "other"])).toThrow("not part of the render");
  });
});

type Project = { id: string; renderId: string | null; renderPlan: unknown; clips: number };

function fakeDb(projects: Project[]) {
  const updates: { id: string; renderStep: string }[] = [];
  const db = {
    clipProject: {
      findMany: async () => projects.map(({ clips, ...project }) => ({ ...project, _count: { clips } })),
      update: async ({ where, data }: { where: { id: string }; data: { renderStep: string } }) => {
        updates.push({ id: where.id, renderStep: data.renderStep });
      },
    },
  };
  return { db: db as unknown as PrismaClient, updates };
}

function fakeJobs(open: Record<string, ClipJob[]> = {}) {
  const sent: string[] = [];
  const cancelled: string[] = [];
  const jobs: ClipJobs = {
    open: async (projectId) => open[projectId] ?? [],
    cancel: async (ids) => void cancelled.push(...ids),
    send: async (projectId, renderId) => (sent.push(`${projectId}:${renderId}`), "job"),
  };
  return { jobs, sent, cancelled };
}

describe("requeueInterruptedRenders", () => {
  it("cancels the job the closed worker had claimed and queues the render again", async () => {
    const { db, updates } = fakeDb([{ id: "p1", renderId: "r1", renderPlan: plan, clips: 1 }]);
    const queue = fakeJobs({ p1: [{ id: "j1", state: "active", renderId: "r1" }] });

    expect(await requeueInterruptedRenders({ db, jobs: queue.jobs })).toEqual(["p1"]);

    expect(queue.cancelled).toEqual(["j1"]);
    expect(queue.sent).toEqual(["p1:r1"]);
    expect(updates).toEqual([{ id: "p1", renderStep: "Resuming… clip 2 of 3" }]);
  });

  it("queues a render that had not stored its plan yet, which then starts over", async () => {
    const { db, updates } = fakeDb([{ id: "p1", renderId: "r1", renderPlan: null, clips: 0 }]);
    const queue = fakeJobs();

    await requeueInterruptedRenders({ db, jobs: queue.jobs });

    expect(queue.sent).toEqual(["p1:r1"]);
    expect(updates).toEqual([{ id: "p1", renderStep: "Resuming…" }]);
  });

  it("leaves a render whose job is still waiting to run", async () => {
    const { db } = fakeDb([{ id: "p1", renderId: "r1", renderPlan: null, clips: 0 }]);
    const queue = fakeJobs({ p1: [{ id: "j1", state: "created", renderId: "r1" }] });

    expect(await requeueInterruptedRenders({ db, jobs: queue.jobs })).toEqual([]);
    expect(queue.sent).toEqual([]);
    expect(queue.cancelled).toEqual([]);
  });

  it("replaces a waiting job of an earlier render", async () => {
    const { db } = fakeDb([{ id: "p1", renderId: "r2", renderPlan: null, clips: 0 }]);
    const queue = fakeJobs({ p1: [{ id: "j1", state: "created", renderId: undefined }] });

    await requeueInterruptedRenders({ db, jobs: queue.jobs });

    expect(queue.cancelled).toEqual(["j1"]);
    expect(queue.sent).toEqual(["p1:r2"]);
  });

  it("throws on a rendering project without a render id", async () => {
    const { db } = fakeDb([{ id: "p1", renderId: null, renderPlan: null, clips: 0 }]);
    await expect(requeueInterruptedRenders({ db, jobs: fakeJobs().jobs })).rejects.toThrow("no render id");
  });
});
