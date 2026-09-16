import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store/memory-store";
import { setStoreForTests } from "@/server/store";
import { setServicesForTests } from "@/server/application/services";
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

describe("diagnostics view", () => {
  it("returns a redacted operational projection", async () => {
    const state = createFixtureState();
    const provider = state.providers[0];
    state.workspace.workerHeartbeatAt = new Date().toISOString();
    state.runs.push({
      id: "run-diagnostics",
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id,
      triggerMessageId: "message-diagnostics",
      memberSnapshot: [state.employees[0].id],
      status: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString()
    });
    state.providerAttempts.push({
      id: "attempt-diagnostics",
      runId: "run-diagnostics",
      workspaceId: state.workspace.id,
      purpose: "conversation",
      provider: provider.provider,
      modelId: state.employees[0].modelId,
      targetOrder: 0,
      attempt: 1,
      status: "failed",
      errorKind: "timeout",
      errorCode: "provider_timeout",
      usage: { source: "unknown" },
      startedAt: new Date().toISOString()
    });
    setStoreForTests(new MemoryStore(state));
    setServicesForTests(undefined);

    const response = await handleApiRequest(
      new Request("http://localhost/api/diagnostics"),
      ["diagnostics"]
    );
    const body = await response.text();
    const payload = JSON.parse(body) as {
      runs: {
        active: Array<{
          id: string;
          actions: Array<{ kind: string; method: string; href: string }>;
        }>;
      };
      failures: Array<{
        latestAttemptId: string;
        failureKinds: string[];
        href: string;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body).toContain("provider_timeout");
    expect(payload.runs.active[0].actions).toContainEqual({
      kind: "cancel",
      method: "DELETE",
      href: "/api/runs/run-diagnostics"
    });
    expect(payload.failures[0]).toMatchObject({
      latestAttemptId: "attempt-diagnostics",
      failureKinds: ["timeout"],
      href: expect.stringContaining("conversation=")
    });
    expect(body).not.toContain("encryptedCredential");
    expect(body).not.toContain("test-api-key");
  });
});
