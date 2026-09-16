import { describe, expect, it } from "vitest";
import { buildDiagnosticsView } from "@/server/application/diagnostics-view";
import {
  createFixtureDiscussion,
  createFixtureModelPricing,
  createFixtureProviderAttempt,
  createFixtureState
} from "@/server/test-support/fixtures";

describe("Diagnostics view", () => {
  const clock = () => new Date("2026-09-16T12:00:00.000Z");

  it("derives worker and provider health from persisted evidence", () => {
    const state = createFixtureState();
    state.workspace.workerHeartbeatAt = "2026-09-16T11:59:50.000Z";
    const provider = state.providers[0];
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-healthy",
        provider: provider.provider,
        startedAt: "2026-09-16T11:59:00.000Z",
        completedAt: "2026-09-16T11:59:01.000Z"
      })
    );

    let view = buildDiagnosticsView(state, clock);
    expect(view.worker.status).toBe("healthy");
    expect(view.providers[0].status).toBe("healthy");

    state.providerAttempts[0].status = "failed";
    state.providerAttempts[0].errorKind = "rate_limited";
    view = buildDiagnosticsView(state, clock);
    expect(view.providers[0]).toMatchObject({
      status: "degraded",
      lastErrorKind: "rate_limited"
    });

    state.providerAttempts[0].startedAt = "2026-09-14T12:00:00.000Z";
    view = buildDiagnosticsView(state, clock);
    expect(view.providers[0].status).toBe("stale");

    state.providerAttempts = [];
    view = buildDiagnosticsView(state, clock);
    expect(view.providers[0]).toMatchObject({
      status: "unknown",
      lastValidatedAt: provider.lastValidatedAt
    });

    state.workspace.workerHeartbeatAt = "not-a-date";
    view = buildDiagnosticsView(state, clock);
    expect(view.worker.status).toBe("unknown");
  });

  it("summarizes usage, pricing coverage, retries, and fallbacks", () => {
    const state = createFixtureState();
    const provider = state.providers[0];
    const employee = state.employees[0];
    state.modelPricing.push(
      createFixtureModelPricing({
        provider: provider.provider,
        modelId: employee.modelId,
        effectiveAt: "2026-01-01T00:00:00.000Z"
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-usage",
        provider: provider.provider,
        modelId: employee.modelId,
        attempt: 2,
        targetOrder: 1,
        fallbackFromAttemptId: "attempt-primary",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          source: "provider"
        },
        startedAt: "2026-09-16T11:59:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-unknown",
        provider: provider.provider,
        modelId: employee.modelId,
        usage: { source: "unknown" },
        startedAt: "2026-09-16T11:58:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-missing-usage",
        provider: provider.provider,
        modelId: employee.modelId,
        usage: { source: "provider" },
        startedAt: "2026-09-16T11:57:00.000Z"
      })
    );

    const view = buildDiagnosticsView(state, clock);

    expect(view.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      unknownUsageAttempts: 2,
      retryAttempts: 1,
      fallbackAttempts: 1
    });
    expect(view.usage.estimatedCostMicros).toBeGreaterThan(0);
  });

  it("includes active work context and groups failures without exposing credentials", () => {
    const state = createFixtureState();
    const conversation = state.conversations[0];
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: conversation.id
    });
    discussion.status = "interrupted";
    discussion.events = [
      {
        id: "event-interrupted",
        workspaceId: state.workspace.id,
        discussionId: discussion.id,
        sequence: 1,
        type: "discussion_interrupted",
        payload: { code: "provider_timeout" },
        createdAt: "2026-09-16T11:59:00.000Z"
      }
    ];
    state.discussions.push(discussion);
    state.tasks.push({
      id: "task-diagnostics",
      workspaceId: state.workspace.id,
      conversationId: conversation.id,
      title: "Diagnose runtime",
      goal: "Inspect the active work.",
      assigneeIds: [state.employees[0].id],
      status: "in_progress",
      history: [],
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.runs.push({
      id: "run-active",
      workspaceId: state.workspace.id,
      conversationId: conversation.id,
      taskId: "task-diagnostics",
      triggerMessageId: "message-active",
      memberSnapshot: [state.employees[0].id],
      status: "running",
      errorCode: "provider_timeout",
      createdAt: "2026-09-16T11:59:00.000Z",
      startedAt: "2026-09-16T11:59:00.000Z"
    });
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-failure-1",
        status: "failed",
        errorKind: "timeout",
        errorCode: "provider_timeout",
        usage: { source: "unknown" },
        startedAt: "2026-09-16T11:58:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-failure-2",
        status: "ambiguous",
        errorKind: "unknown",
        errorCode: "provider_ambiguous",
        usage: { source: "unknown" },
        startedAt: "2026-09-16T11:59:00.000Z"
      })
    );

    const view = buildDiagnosticsView(state, clock);
    const serialized = JSON.stringify(view);

    expect(view.runs.active).toContainEqual(
      expect.objectContaining({
        id: "run-active",
        conversationTitle: conversation.title,
        taskTitle: "Diagnose runtime"
      })
    );
    expect(view.discussions).toContainEqual(
      expect.objectContaining({
        id: discussion.id,
        status: "interrupted",
        reason: "provider_timeout"
      })
    );
    expect(view.failures).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        modelId: "test-model",
        count: 2,
        statuses: expect.arrayContaining(["ambiguous", "failed"]),
        errorKinds: expect.arrayContaining(["timeout", "unknown"]),
        errorCodes: expect.arrayContaining([
          "provider_timeout",
          "provider_ambiguous"
        ])
      })
    );
    expect(serialized).not.toContain("encryptedCredential");
    expect(serialized).not.toContain("test-api-key");
  });

  it("bounds provider evidence and failure groups to the latest 50 attempts", () => {
    const state = createFixtureState();
    state.providerAttempts.push(
      ...Array.from({ length: 55 }, (_, index) =>
        createFixtureProviderAttempt({
          id: `attempt-bounded-${index}`,
          status: "failed",
          errorCode: "provider_timeout",
          usage: { source: "unknown" },
          startedAt: new Date(
            Date.parse("2026-09-16T11:59:00.000Z") - index * 1_000
          ).toISOString()
        })
      )
    );

    const view = buildDiagnosticsView(state, clock);

    expect(view.providers[0].recentAttemptCount).toBe(50);
    expect(view.failures[0]).toMatchObject({
      count: 50,
      lastOccurredAt: "2026-09-16T11:59:00.000Z"
    });
  });
});
