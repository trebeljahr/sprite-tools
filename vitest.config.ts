import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The algorithm modules construct `new ImageData(...)` for results.
    // Node doesn't ship a global ImageData, so preload the same shim the
    // CLI uses.
    setupFiles: ["tests/setup.ts"],
  },
});
