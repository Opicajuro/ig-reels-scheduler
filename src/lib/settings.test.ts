import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  emailSettings,
  fillMissingSettings,
  getSettings,
  openSecret,
  r2Settings,
  saveR2Settings,
  saveSettings,
  sealSecret,
  type R2SettingsInput,
  type SettingsInput,
} from "./settings";

const KEY = Buffer.alloc(32, 7);

type Row = Record<string, unknown>;

// An in-memory Setting table with the one row the module uses.
function fakeDb(initial: Row | null = null) {
  let row = initial;
  const db = {
    setting: {
      findUnique: async () => row,
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        row = row ? { ...row, ...update } : { metaAppSecret: null, resendApiKey: null, r2SecretAccessKey: null, ...create };
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
      r2AccountId: null,
      r2AccessKeyId: null,
      r2SecretAccessKey: null,
      r2Bucket: null,
    });
  });
});

describe("saveSettings", () => {
  it("stores the secrets sealed and reads them back opened", async () => {
    const { db, row } = fakeDb();
    await saveSettings(db, INPUT);

    expect(row()?.metaAppSecret).not.toBe("app-secret");
    expect(row()?.resendApiKey).not.toBe("re_test");
    expect(await getSettings(db)).toMatchObject({ ...INPUT });
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

const R2: R2SettingsInput = {
  r2AccountId: "0123456789abcdef0123456789abcdef",
  r2AccessKeyId: "key-id",
  r2SecretAccessKey: "r2-secret",
  r2Bucket: "localirs-ig",
};

describe("saveR2Settings", () => {
  it("stores the secret access key sealed and turns Instagram posting on", async () => {
    const { db, row } = fakeDb();
    await saveR2Settings(db, { ...R2, r2AccountId: " 0123456789abcdef0123456789abcdef " });

    expect(row()?.r2SecretAccessKey).not.toContain("r2-secret");
    expect(r2Settings(await getSettings(db))).toEqual({
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "key-id",
      secretAccessKey: "r2-secret",
      bucket: "localirs-ig",
    });
  });

  it("keeps the saved secret access key when its field is left empty", async () => {
    const { db } = fakeDb();
    await saveR2Settings(db, R2);
    await saveR2Settings(db, { ...R2, r2SecretAccessKey: "", r2Bucket: "other-bucket" });

    const settings = await getSettings(db);
    expect(settings.r2SecretAccessKey).toBe("r2-secret");
    expect(settings.r2Bucket).toBe("other-bucket");
  });

  it.each(["r2AccountId", "r2AccessKeyId", "r2SecretAccessKey", "r2Bucket"] as const)(
    "refuses the settings without %s, since R2 needs all four",
    async (field) => {
      const { db, row } = fakeDb();
      await expect(saveR2Settings(db, { ...R2, [field]: " " })).rejects.toThrow(
        "Cloudflare R2 needs all four: the account ID, the access key ID, the secret access key and the bucket name",
      );
      expect(row()).toBeNull();
    },
  );

  it("refuses an account ID that is not 32 letters and digits", async () => {
    await expect(saveR2Settings(fakeDb().db, { ...R2, r2AccountId: "my-account" })).rejects.toThrow(
      "the R2 account ID is 32 letters and digits",
    );
  });

  it("refuses a bucket name R2 would not accept", async () => {
    await expect(saveR2Settings(fakeDb().db, { ...R2, r2Bucket: "My_Bucket" })).rejects.toThrow(
      "an R2 bucket name is 3 to 63 lowercase letters, digits and hyphens",
    );
  });

  it("clears all four, saved secret too, when every field is empty", async () => {
    const { db } = fakeDb();
    await saveR2Settings(db, R2);
    await saveR2Settings(db, { r2AccountId: "", r2AccessKeyId: "", r2SecretAccessKey: "", r2Bucket: "" });

    const settings = await getSettings(db);
    expect(settings.r2SecretAccessKey).toBeNull();
    expect(r2Settings(settings)).toBeNull();
  });

  it("leaves the other settings alone", async () => {
    const { db } = fakeDb();
    await saveSettings(db, INPUT);
    await saveR2Settings(db, R2);
    expect(await getSettings(db)).toMatchObject(INPUT);
  });
});
