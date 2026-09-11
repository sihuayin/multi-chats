import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store/memory-store";
import { setStoreForTests } from "@/server/store";
import { createInitialState } from "@/server/store/initial-state";
import { handleApiRequest } from "@/server/http/router";

describe("health endpoint", () => {
  it("reports ready web, database, and worker state", async () => {
    const state = createInitialState("00000000-0000-4000-8000-000000000001");
    state.workspace.workerHeartbeatAt = new Date().toISOString();
    setStoreForTests(new MemoryStore(state));

    const response = await handleApiRequest(
      new Request("http://localhost/api/health"),
      ["health"]
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      database: "ok",
      worker: "ok"
    });
  });

  it("reports a stale worker when its heartbeat is old", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://health-test";
    const state = createInitialState("00000000-0000-4000-8000-000000000001");
    state.workspace.workerHeartbeatAt = new Date(Date.now() - 60_000).toISOString();
    setStoreForTests(new MemoryStore(state));

    try {
      const response = await handleApiRequest(
        new Request("http://localhost/api/health"),
        ["health"]
      );

      await expect(response.json()).resolves.toMatchObject({
        status: "degraded",
        database: "ok",
        worker: "stale"
      });
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});
