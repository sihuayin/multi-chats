import { defineConfig, devices } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3000";
// Address the dev server by IPv4 explicitly: `npm run dev` binds 0.0.0.0, while
// this machine resolves `localhost` to ::1, which Playwright's readiness check
// tries and does not fall back from.
const host = process.env.PLAYWRIGHT_HOST ?? "127.0.0.1";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: `http://${host}:${port}`,
    trace: "on-first-retry"
  },
  webServer: {
    command:
      `DATABASE_URL= SQLITE_PATH=$(mktemp /tmp/multi-chats-e2e.XXXXXX) MODEL_MODE=fake MODEL_STREAM_DELAY_MS=150 npm run dev -- --port ${port}`,
    url: `http://${host}:${port}/api/health`,
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
