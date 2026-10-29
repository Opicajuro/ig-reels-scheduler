import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { emailSettings, fillMissingSettings, getSettings, openSecret, saveSettings, sealSecret, type SettingsInput } from "./settings";

const KEY = Buffer.alloc(32, 7);

type Row = Record<string, unknown>;

// An in-memory Setting table with the one row the module uses.
function fakeDb(initial: Row | null = null) {
  let row = initial;
  const db = {
    setting: {
      findUnique: async () => row,
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        row = row ? { ...row, ...update } : { metaAppSecret: null, resendApiKey: null, ...create };
        return row;
      },
    },
  };
  return { db: db as unknown as PrismaClient, row: () => row };
}

const INPUT: SettingsInput = {
  metaAppId: "123",
  metaAppSecret: "app-secret",
  alertEmail: "me@example.test",
  resendApiKey: "re_test",
  emailFrom: "Localirs <onboarding@resend.dev>",
};

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = KEY.toString("base64");
});

afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
});

describe("sealSecret / openSecret", () => {
  it("round-trips a secret without storing the plaintext", () => {
    const sealed = sealSecret("app-secret", KEY);
    expect(sealed).not.toContain("app-secret");
    expect(openSecret(sealed, KEY)).toBe("app-secret");
  });

  it("fails with another key", () => {
    expect(() => openSecret(sealSecret("app-secret", KEY), Buffer.alloc(32, 9))).toThrow();
  });
});

describe("getSettings", () => {
  it("is empty before anything is saved", async () => {
    expect(await getSettings(fakeDb().db)).toEqual({
      metaAppId: null,
      metaAppSecret: null,
      alertEmail: null,
      resendApiKey: null,
      emailFrom: null,
    });
  });
});

describe("saveSettings", () => {
  it("stores the secrets sealed and reads them back opened", async () => {
    const { db, row } = fakeDb();
    await saveSettings(db, INPUT);

    expect(row()?.metaAppSecret).not.toBe("app-secret");
    expect(row()?.resendApiKey).not.toBe("re_test");
    expect(await getSettings(db)).toEqual({ ...INPUT });
  });

  it("keeps a saved secret when its field is left empty", async () => {
    const { db } = fakeDb();
    await saveSettings(db, INPUT);
    await saveSettings(db, { ...INPUT, metaAppSecret: "", resendApiKey: " ", metaAppId: "456" });

    const settings = await getSettings(db);
    expect(settings.metaAppId).toBe("456");
    expect(settings.metaAppSecret).toBe("app-secret");
    expect(settings.resendApiKey).toBe("re_test");
  });

  it("refuses failure-email settings that are only partly filled in", async () => {
    const { db } = fakeDb();
    await expect(saveSettings(db, { ...INPUT, resendApiKey: "" })).rejects.toThrow("failure emails need all three");
    await expect(saveSettings(db, { ...INPUT, emailFrom: "" })).rejects.toThrow("failure emails need all three");
  });

  it("turns failure emails off when the address and sender are cleared", async () => {
    const { db } = fakeDb();
    await saveSettings(db, INPUT);
    await saveSettings(db, { ...INPUT, alertEmail: "", emailFrom: "", resendApiKey: "" });
    expect(emailSettings(await getSettings(db))).toBeNull();
  });

  it("refuses an address without @", async () => {
    const { db } = fakeDb();
    await expect(saveSettings(db, { ...INPUT, alertEmail: "me" })).rejects.toThrow("does not look like an email");
  });
});

describe("fillMissingSettings", () => {
  it("fills only the settings that are still empty", async () => {
    const { db } = fakeDb();
    await saveSettings(db, { ...INPUT, metaAppId: "", metaAppSecret: "" });
    await fillMissingSettings(db, {
      metaAppId: "from-env",
      metaAppSecret: "env-secret",
      alertEmail: "installer@example.test",
      resendApiKey: "re_installer",
      emailFrom: null,
    });

    const settings = await getSettings(db);
    expect(settings.metaAppId).toBe("from-env");
    expect(settings.metaAppSecret).toBe("env-secret");
    expect(settings.alertEmail).toBe("me@example.test");
    expect(settings.resendApiKey).toBe("re_test");
  });

  it("creates the row on a new install", async () => {
    const { db } = fakeDb();
    await fillMissingSettings(db, {
      metaAppId: null,
      metaAppSecret: null,
      alertEmail: "me@example.test",
      resendApiKey: "re_test",
      emailFrom: "Localirs <onboarding@resend.dev>",
    });
    expect(emailSettings(await getSettings(db))).toEqual({
      to: "me@example.test",
      apiKey: "re_test",
      from: "Localirs <onboarding@resend.dev>",
    });
  });
});
