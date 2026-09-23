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
      validationStatus: "validated",
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
        runId: "run-active",
        status: "failed",
        errorKind: "timeout",
        errorCode: "provider_timeout",
        usage: { source: "unknown" },
        startedAt: "2026-09-16T11:58:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-failure-2",
        runId: "run-active",
        status: "ambiguous",
        errorKind: "unknown",
        errorCode: "provider_ambiguous",
        targetOrder: 1,
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
        taskTitle: "Diagnose runtime",
        actions: [
          {
            kind: "stop",
            method: "POST",
            href: "/api/tasks/task-diagnostics/stop"
          }
        ]
      })
    );
    expect(view.discussions).toContainEqual(
      expect.objectContaining({
        id: discussion.id,
        status: "interrupted",
        reason: "provider_timeout",
        actions: expect.arrayContaining([
          expect.objectContaining({ kind: "retry" }),
          expect.objectContaining({ kind: "cancel" })
        ])
      })
    );
    expect(view.failures).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        modelId: "test-model",
        count: 2,
        attemptIds: ["attempt-failure-2", "attempt-failure-1"],
        runIds: ["run-active"],
        statuses: expect.arrayContaining(["ambiguous", "failed"]),
        failureKinds: expect.arrayContaining(["timeout", "ambiguous"]),
        usedFallback: true,
        errorKinds: expect.arrayContaining(["timeout", "unknown"]),
        errorCodes: expect.arrayContaining([
          "provider_timeout",
          "provider_ambiguous"
        ]),
        runId: "run-active",
        taskId: "task-diagnostics",
        href: expect.stringContaining("task=task-diagnostics")
      })
    );
    expect(serialized).not.toContain("encryptedCredential");
    expect(serialized).not.toContain("test-api-key");
  });

  it("offers only valid recovery commands for failed and interrupted Runs", () => {
    const state = createFixtureState();
    const conversation = state.conversations[0];
    state.tasks.push({
      id: "task-recovery",
      workspaceId: state.workspace.id,
      conversationId: conversation.id,
      title: "Recover failed work",
      goal: "Retry the failed Task Run.",
      assigneeIds: [state.employees[0].id],
      status: "in_progress",
      history: [],
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.runs.push(
      {
        id: "run-task-failed",
        workspaceId: state.workspace.id,
        conversationId: conversation.id,
        taskId: "task-recovery",
        triggerMessageId: "message-task-failed",
        memberSnapshot: [state.employees[0].id],
        status: "failed",
        errorCode: "provider_timeout",
        createdAt: "2026-09-16T11:50:00.000Z",
        startedAt: "2026-09-16T11:50:00.000Z",
        completedAt: "2026-09-16T11:51:00.000Z"
      },
      {
        id: "run-interrupted",
        workspaceId: state.workspace.id,
        conversationId: conversation.id,
        triggerMessageId: "message-interrupted",
        memberSnapshot: [state.employees[1].id],
        status: "interrupted",
        createdAt: "2026-09-16T11:40:00.000Z",
        startedAt: "2026-09-16T11:40:00.000Z",
        completedAt: "2026-09-16T11:41:00.000Z"
      }
    );

    const view = buildDiagnosticsView(state, clock);
    const taskRun = view.runs.recoverable.find(
      (run) => run.id === "run-task-failed"
    );
    const interruptedRun = view.runs.recoverable.find(
      (run) => run.id === "run-interrupted"
    );

    expect(taskRun?.actions).toEqual([
      {
        kind: "retry",
        method: "POST",
        href: "/api/tasks/task-recovery/run"
      }
    ]);
    expect(interruptedRun?.actions).toEqual([
      {
        kind: "resume",
        method: "POST",
        href: "/api/runs/run-interrupted/resume"
      }
    ]);

    state.runEvents.push({
      id: "event-tool-started",
      workspaceId: state.workspace.id,
      runId: "run-interrupted",
      sequence: 1,
      type: "tool_started",
      payload: { messageId: "message-tool" },
      createdAt: "2026-09-16T11:40:30.000Z"
    });
    const blockedView = buildDiagnosticsView(state, clock);
    expect(
      blockedView.runs.recoverable.find(
        (run) => run.id === "run-interrupted"
      )
    ).toBeUndefined();
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

describe("Diagnostics retrieval", () => {
  const clock = () => new Date("2026-09-16T12:00:00.000Z");

  function seedCorpus(state: ReturnType<typeof createFixtureState>) {
    const now = "2026-01-01T00:00:00.000Z";
    const base = { workspaceId: state.workspace.id, createdAt: now, updatedAt: now };
    state.sources.push(
      {
        ...base,
        id: "source-ready",
        title: "Ready",
        kind: "file",
        location: "ready.md",
        status: "ready",
        chunkCount: 2
      },
      {
        ...base,
        id: "source-tombstoned",
        title: "Tombstoned",
        kind: "file",
        location: "old.md",
        status: "ready",
        chunkCount: 1,
        deletedAt: now
      },
      {
        ...base,
        id: "source-ingesting",
        title: "Ingesting",
        kind: "file",
        location: "new.md",
        status: "ingesting",
        chunkCount: 1
      }
    );
    const chunk = (id: string, sourceId: string, index: number, superseded?: boolean) => ({
      ...base,
      id,
      sourceId,
      index,
      content: `Content of ${id}.`,
      contentHash: `hash-${id}`,
      ...(superseded ? { superseded: true } : {})
    });
    state.chunks.push(
      chunk("chunk-current", "source-ready", 0),
      chunk("chunk-superseded", "source-ready", 1, true),
      chunk("chunk-tombstoned", "source-tombstoned", 0),
      chunk("chunk-ingesting", "source-ingesting", 0)
    );
  }

  function searchEvent(
    state: ReturnType<typeof createFixtureState>,
    id: string,
    sequence: number,
    toolName: string,
    durationMs?: number
  ) {
    state.runEvents.push({
      id,
      workspaceId: state.workspace.id,
      runId: "run-search",
      sequence,
      type: "tool_completed",
      payload: {
        toolName,
        isError: false,
        ...(durationMs !== undefined ? { durationMs } : {})
      },
      createdAt: "2026-09-16T11:00:00.000Z"
    });
  }

  it("shows how many chunks a search would consider, and how long recent searches took", () => {
    const state = createFixtureState();
    seedCorpus(state);
    searchEvent(state, "event-1", 1, "search_sources", 10);
    searchEvent(state, "event-other", 2, "current_time", 999);
    searchEvent(state, "event-2", 3, "search_sources", 20);
    searchEvent(state, "event-3", 4, "search_sources", 30);
    // A completion from before durations were recorded still counts.
    searchEvent(state, "event-4", 5, "search_sources");

    const retrieval = buildDiagnosticsView(state, clock).retrieval;

    // Only the current chunk of the ready, non-deleted Source counts.
    expect(retrieval.searchableChunkCount).toBe(1);
    expect(retrieval.recentSearchCount).toBe(4);
    // Newest first; the other Tool's duration is not a search.
    expect(retrieval.recentSearchDurationsMs).toEqual([30, 20, 10]);
  });

  it("caps the duration sample while keeping the true call count", () => {
    const state = createFixtureState();
    for (let index = 0; index < 25; index += 1) {
      searchEvent(state, `event-${index}`, index, "search_sources", index);
    }
    const retrieval = buildDiagnosticsView(state, clock).retrieval;
    expect(retrieval.recentSearchCount).toBe(25);
    expect(retrieval.recentSearchDurationsMs).toHaveLength(20);
    expect(retrieval.recentSearchDurationsMs[0]).toBe(24);
  });

  it("shows zero rather than an error for a Workspace with no Sources", () => {
    const state = createFixtureState();
    const retrieval = buildDiagnosticsView(state, clock).retrieval;
    expect(retrieval).toEqual({
      searchableChunkCount: 0,
      recentSearchCount: 0,
      recentSearchDurationsMs: []
    });
  });

  it("carries no recall or quality figure and raises no alert", () => {
    const state = createFixtureState();
    seedCorpus(state);
    const retrieval = buildDiagnosticsView(state, clock).retrieval;
    expect(Object.keys(retrieval).sort()).toEqual([
      "recentSearchCount",
      "recentSearchDurationsMs",
      "searchableChunkCount"
    ]);
  });
});
