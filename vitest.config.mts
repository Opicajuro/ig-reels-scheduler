import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import "dotenv/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    testTimeout: 120_000,
    // Fixture videos are made with ffmpeg in beforeAll, which is slow while the render tests share the CPU.
    hookTimeout: 120_000,
  },
});
