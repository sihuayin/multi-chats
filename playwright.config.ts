import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry"
  },
  webServer: {
    command:
      "DATABASE_URL= SQLITE_PATH=.data/e2e.sqlite MODEL_MODE=fake MODEL_STREAM_DELAY_MS=150 npm run dev",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: false,
    timeout: 180_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
