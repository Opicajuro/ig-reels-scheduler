import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { buildLocalValues, isEntryPoint, settingsFromSetup, type LocalInstall } from "./local-setup";

const install: LocalInstall = {
  postgresPassword: "pg-secret",
  storageSecret: "storage-secret",
  resendApiKey: "re_test",
  emailFrom: "Scheduler <alerts@example.test>",
  alertEmail: "me@example.test",
  chromePath: "C:\\Localirs\\tools\\chrome\\chrome.exe",
  whisperBin: "C:\\Localirs\\tools\\whisper\\whisper-cli.exe",
  whisperModel: "C:\\Localirs\\tools\\whisper\\ggml-large-v3-turbo-q5_0.bin",
  kokoroModel: "C:\\Localirs\\tools\\kokoro\\Kokoro-82M-v1.0-ONNX",
  dataDir: "C:\\Localirs\\data",
  pgBin: "C:\\Localirs\\tools\\postgres\\bin",
};

describe("buildLocalValues", () => {
  it("points the app at the Postgres and file storage that run on this PC", () => {
    const values = buildLocalValues(install, () => "generated");
    expect(values.DATABASE_URL).toBe("postgresql://localirs:pg-secret@127.0.0.1:5432/localirs");
    expect(values.S3_ENDPOINT).toBe("http://127.0.0.1:9000");
    expect(values.S3_BUCKET).toBe("ig-reels");
    expect(values.S3_SECRET_KEY).toBe("storage-secret");
  });

  it("uses the tool paths and generates the token key", () => {
    const values = buildLocalValues(install, () => "generated");
    expect(values.CHROME_PATH).toBe(install.chromePath);
    expect(values.WHISPER_BIN).toBe(install.whisperBin);
    expect(values.WHISPER_MODEL).toBe(install.whisperModel);
    expect(values.KOKORO_MODEL).toBe(install.kokoroModel);
    expect(values.LOCALIRS_DATA_DIR).toBe(install.dataDir);
    expect(values.PG_BIN).toBe(install.pgBin);
    expect(values.TOKEN_ENC_KEY).toBe("generated");
  });

  it("leaves the Meta app and failure-email settings out of .env: they live on /settings", () => {
    const values = buildLocalValues(install, () => "generated");
    for (const key of ["IG_APP_ID", "IG_APP_SECRET", "RESEND_API_KEY", "EMAIL_FROM"]) expect(values).not.toHaveProperty(key);
  });
});

describe("settingsFromSetup", () => {
  it("takes the installer's failure-email answers over the values an older .env had", () => {
    const oldEnv = { RESEND_API_KEY: "re_old", EMAIL_FROM: "Old <old@example.test>", IG_APP_ID: "123", IG_APP_SECRET: "shh" };
    expect(settingsFromSetup(install, oldEnv)).toEqual({
      metaAppId: "123",
      metaAppSecret: "shh",
      alertEmail: "me@example.test",
      resendApiKey: "re_test",
      emailFrom: "Scheduler <alerts@example.test>",
    });
  });

  it("copies the older .env values when the installer had no answers, and leaves the rest empty", () => {
    const noAnswers = { ...install, resendApiKey: "", emailFrom: "", alertEmail: "" };
    expect(settingsFromSetup(noAnswers, { RESEND_API_KEY: "re_old", EMAIL_FROM: "Old <old@example.test>", IG_APP_ID: "" })).toEqual({
      metaAppId: null,
      metaAppSecret: null,
      alertEmail: null,
      resendApiKey: "re_old",
      emailFrom: "Old <old@example.test>",
    });
  });
});

describe("isEntryPoint", () => {
  it("matches the script path even when it has a space, which a plain file:// comparison misses", () => {
    const scriptPath = "/opt/Local App/scripts/local-setup.ts";
    expect(`file://${scriptPath}` === pathToFileURL(scriptPath).href).toBe(false);
    expect(isEntryPoint(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
  });

  it("is false when the module was imported rather than run", () => {
    expect(isEntryPoint(pathToFileURL("/app/scripts/local-setup.ts").href, "/app/node_modules/vitest/cli.js")).toBe(false);
    expect(isEntryPoint(pathToFileURL("/app/scripts/local-setup.ts").href, undefined)).toBe(false);
  });
});
