import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent/shared": resolve(import.meta.dirname, "packages/shared/src/index.ts"),
      "@agent/database": resolve(import.meta.dirname, "packages/database/src/index.ts"),
      "@agent/core": resolve(import.meta.dirname, "packages/core/src/index.ts"),
      "@agent/codex-provider": resolve(import.meta.dirname, "packages/codex-provider/src/index.ts"),
      "@agent/ai": resolve(import.meta.dirname, "packages/ai/src/index.ts")
    }
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "coverage",
      include: ["packages/**/*.ts", "apps/daemon/src/**/*.ts"]
    }
  }
});
