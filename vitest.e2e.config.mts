import { defineConfig } from "vitest/config";

// Browser checks against a running Localirs (pnpm e2e): E2E_URL is its address, CHROME_PATH the Chromium to drive.
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
  },
});
