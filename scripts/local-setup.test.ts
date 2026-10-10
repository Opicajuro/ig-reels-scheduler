import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { buildLocalValues, isEntryPoint, type LocalInstall } from "./local-setup";

const install: LocalInstall = {
  postgresPassword: "pg-secret",
  storageSecret: "storage-secret",
  resendApiKey: "re_test",
  emailFrom: "Scheduler <alerts@example.test>",
  chromePath: "C:\\Localirs\\tools\\chrome\\chrome.exe",
  whisperBin: "C:\\Localirs\\tools\\whisper\\whisper-cli.exe",
  whisperModel: "C:\\Localirs\\tools\\whisper\\ggml-base.bin",
};

describe("buildLocalValues", () => {
  it("points the app at the Postgres and file storage that run on this PC", () => {
    const values = buildLocalValues(install, () => "generated");
    expect(values.DATABASE_URL).toBe("postgresql://localirs:pg-secret@127.0.0.1:5432/localirs");
    expect(values.S3_ENDPOINT).toBe("http://127.0.0.1:9000");
    expect(values.S3_BUCKET).toBe("ig-reels");
    expect(values.S3_SECRET_KEY).toBe("storage-secret");
    expect(values.AUTH_TRUST_HOST).toBe("true");
  });

  it("uses the tool paths and generates the two app secrets", () => {
    const values = buildLocalValues(install, () => "generated");
    expect(values.CHROME_PATH).toBe(install.chromePath);
    expect(values.WHISPER_BIN).toBe(install.whisperBin);
    expect(values.WHISPER_MODEL).toBe(install.whisperModel);
    expect(values.TOKEN_ENC_KEY).toBe("generated");
    expect(values.AUTH_SECRET).toBe("generated");
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
