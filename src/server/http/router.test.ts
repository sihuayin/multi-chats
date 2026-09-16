import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store/memory-store";
import { setStoreForTests } from "@/server/store";
import { createInitialState } from "@/server/store/initial-state";
import { handleApiRequest } from "@/server/http/router";
import {
  createFixtureState,
  addFixtureTaskRunCorrelation
} from "@/server/test-support/fixtures";

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

  it("reports database unavailability instead of returning a generic 500", async () => {
    setStoreForTests({
      async read() {
        throw new Error("database unavailable");
      },
      async update() {
        throw new Error("database unavailable");
      }
    });

    const response = await handleApiRequest(
      new Request("http://localhost/api/health"),
      ["health"]
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "unavailable",
      database: "error",
      worker: "unknown"
    });
  });
});

describe("workspace view", () => {
  it("exposes optional Task, Run, and Message correlations", async () => {
    const state = createFixtureState();
    const { task, message, run } = addFixtureTaskRunCorrelation(state);
    setStoreForTests(new MemoryStore(state));

    const response = await handleApiRequest(
      new Request("http://localhost/api/workspace"),
      ["workspace"]
    );
    const view = (await response.json()) as {
      tasks: Array<{
        id: string;
        history: Array<{ runId?: string }>;
        availableActions: string[];
      }>;
      messages: Array<{ id: string; taskId?: string }>;
      runs: Array<{ id: string; taskId?: string }>;
    };

    expect(response.status).toBe(200);
    expect(view.tasks.find((item) => item.id === task.id)?.history).toContainEqual(
      expect.objectContaining({ runId: run.id })
    );
    expect(
      view.tasks.find((item) => item.id === task.id)?.availableActions
    ).toEqual(["stop", "block", "review", "cancel"]);
    expect(view.messages.find((item) => item.id === message.id)?.taskId).toBe(
      task.id
    );
    expect(view.runs.find((item) => item.id === run.id)?.taskId).toBe(task.id);
  });
});
