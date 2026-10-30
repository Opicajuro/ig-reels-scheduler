import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { UserError } from "./user-error";
import { getAppearance, saveAppearance } from "./appearance";

type Row = Record<string, unknown>;

// An in-memory Setting table with the one row the module uses.
function fakeDb(initial: Row | null = null) {
  let row = initial;
  const db = {
    setting: {
      findUnique: async () => row,
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        row = row ? { ...row, ...update } : create;
        return row;
      },
    },
  };
  return { db: db as unknown as PrismaClient, row: () => row };
}

describe("getAppearance", () => {
  it("is Night Spring in its own colours before anything is saved", async () => {
    expect(await getAppearance(fakeDb().db)).toEqual({ design: "night", palette: "default", hue: 0 });
  });

  it("returns the saved design, palette and colour shift", async () => {
    const { db } = fakeDb({ id: 1, design: "cast", palette: "ember", hue: 120 });
    expect(await getAppearance(db)).toEqual({ design: "cast", palette: "ember", hue: 120 });
  });

  it("fails on a design the app does not know", async () => {
    await expect(getAppearance(fakeDb({ id: 1, design: "retro", palette: "default", hue: 0 }).db)).rejects.toThrow(
      "the saved appearance is unknown",
    );
  });
});

describe("saveAppearance", () => {
  it("saves the design, palette and colour shift", async () => {
    const { db, row } = fakeDb();
    await saveAppearance(db, { design: "day", palette: "ocean", hue: "359" });
    expect(row()).toEqual({ id: 1, design: "day", palette: "ocean", hue: 359 });
  });

  it("keeps the other settings in the row", async () => {
    const { db, row } = fakeDb({ id: 1, alertEmail: "me@example.test", design: "night", palette: "default", hue: 0 });
    await saveAppearance(db, { design: "neon", palette: "default", hue: "0" });
    expect(row()).toMatchObject({ alertEmail: "me@example.test", design: "neon" });
  });

  it.each([
    [{ design: "retro", palette: "default", hue: "0" }, "there is no design called retro"],
    [{ design: "night", palette: "neon", hue: "0" }, "there is no colour palette called neon"],
    [{ design: "night", palette: "default", hue: "360" }, "the colour shift must be a whole number from 0 to 359"],
    [{ design: "night", palette: "default", hue: "-5" }, "the colour shift must be a whole number from 0 to 359"],
    [{ design: "night", palette: "default", hue: "12.5" }, "the colour shift must be a whole number from 0 to 359"],
    [{ design: "night", palette: "default", hue: "" }, "the colour shift must be a whole number from 0 to 359"],
    [{ design: "toString", palette: "default", hue: "0" }, "there is no design called toString"],
  ])("refuses %o", async (input, message) => {
    const { db, row } = fakeDb();
    await expect(saveAppearance(db, input)).rejects.toThrow(new UserError(message));
    expect(row()).toBeNull();
  });
});
