import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3000";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry"
  },
  webServer: {
    command:
      `DATABASE_URL= SQLITE_PATH=$(mktemp /tmp/multi-chats-e2e.XXXXXX) MODEL_MODE=fake MODEL_STREAM_DELAY_MS=150 npm run dev -- --port ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
