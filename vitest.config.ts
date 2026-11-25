import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      ROUTER_DB_PATH: ":memory:",
    },
  },
});
