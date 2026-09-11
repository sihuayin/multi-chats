import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": new URL("./src/test-support/server-only.ts", import.meta.url)
        .pathname
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"]
    }
  }
});
