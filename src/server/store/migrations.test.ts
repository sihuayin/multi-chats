import { describe, expect, it } from "vitest";
import { migrateAppState } from "@/server/store/migrations";
import { createInitialState } from "@/server/store/initial-state";
import {
  addFixtureTaskRunCorrelation,
  createFixtureDiscussion,
  createFixtureState
} from "@/server/test-support/fixtures";

describe("AppState migrations", () => {
  it("migrates v1 Task Artifacts to owner fields and adds Discussions", () => {
    const legacy = structuredClone(
      createInitialState("00000000-0000-4000-8000-000000000001")
    ) as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.discussions;
    legacy.artifacts = [
      {
        id: "artifact-1",
        workspaceId: "00000000-0000-4000-8000-000000000001",
        taskId: "task-1",
        type: "text",
        name: "Legacy",
        content: "Legacy artifact",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    const migrated = migrateAppState(legacy);

    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.discussions).toEqual([]);
    expect(migrated.artifacts[0]).toMatchObject({
      id: "artifact-1",
      ownerType: "task",
      ownerId: "task-1"
    });
    expect(migrated.artifacts[0]).not.toHaveProperty("taskId");
  });

  it("is idempotent and preserves current state", () => {
    const current = createFixtureState();
    current.discussions.push(
      createFixtureDiscussion({
        workspaceId: current.workspace.id,
        conversationId: current.conversations[0].id
      })
    );
    const migrated = migrateAppState(structuredClone(current));

    expect(migrated).toEqual(current);
    expect(migrateAppState(structuredClone(migrated))).toEqual(current);
  });

  it("accepts optional Task, Run, and Message correlations", () => {
    const state = createFixtureState();
    const { task, message, run } = addFixtureTaskRunCorrelation(state);
    state.artifacts.push({
      id: "artifact-correlated",
      workspaceId: state.workspace.id,
      ownerType: "task",
      ownerId: task.id,
      runId: run.id,
      type: "json",
      name: "Task result",
      content: JSON.stringify({ complete: true }),
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });

    const migrated = migrateAppState(structuredClone(state));
    const migratedAgain = migrateAppState(structuredClone(migrated));

    expect(migrated.tasks[0].history[1].runId).toBe(run.id);
    expect(migrated.messages[0].taskId).toBe(task.id);
    expect(migrated.runs[0].taskId).toBe(task.id);
    expect(migrated.artifacts[0].runId).toBe(run.id);
    expect(migrated.schemaVersion).toBe(5);
    expect(migratedAgain).toEqual(migrated);
  });

  it("rejects dangling or cross-Conversation Task correlations", () => {
    const cases = [
      {
        mutate(state: ReturnType<typeof createFixtureState>) {
          state.messages.push({
            id: "message-task-dangling",
            workspaceId: state.workspace.id,
            conversationId: state.conversations[0].id,
            taskId: "missing-task",
            authorType: "system",
            authorId: "user",
            content: "Dangling Task reference.",
            status: "complete",
            createdAt: state.workspace.createdAt,
            updatedAt: state.workspace.updatedAt
          });
        },
        message: "Workspace Message Task correlation is invalid"
      },
      {
        mutate(state: ReturnType<typeof createFixtureState>) {
          const { message } = addFixtureTaskRunCorrelation(state);
          message.runId = "missing-run";
        },
        message: "Workspace Message Run correlation is invalid"
      },
      {
        mutate(state: ReturnType<typeof createFixtureState>) {
          addFixtureTaskRunCorrelation(state).message.runId = undefined;
        },
        message: "Workspace Run Task correlation is invalid"
      },
      {
        mutate(state: ReturnType<typeof createFixtureState>) {
          state.tasks.push({
            id: "task-other-conversation",
            workspaceId: state.workspace.id,
            conversationId: "conversation-other",
            title: "Other Conversation",
            goal: "Remain outside the correlation.",
            assigneeIds: [state.employees[0].id],
            status: "draft",
            history: [],
            createdAt: state.workspace.createdAt,
            updatedAt: state.workspace.updatedAt
          });
          state.messages.push({
            id: "message-task-mismatch",
            workspaceId: state.workspace.id,
            conversationId: state.conversations[0].id,
            taskId: "task-other-conversation",
            authorType: "system",
            authorId: "user",
            content: "Mismatched Task conversation.",
            status: "complete",
            createdAt: state.workspace.createdAt,
            updatedAt: state.workspace.updatedAt
          });
        },
        message: "Workspace Message Task correlation is invalid"
      },
      {
        mutate(state: ReturnType<typeof createFixtureState>) {
          state.tasks.push({
            id: "task-history",
            workspaceId: state.workspace.id,
            conversationId: state.conversations[0].id,
            title: "History",
            goal: "Reference a valid Run from history.",
            assigneeIds: [state.employees[0].id],
            status: "in_progress",
            history: [
              {
                status: "in_progress",
                at: state.workspace.updatedAt,
                actorId: "user",
                runId: "missing-run"
              }
            ],
            createdAt: state.workspace.createdAt,
            updatedAt: state.workspace.updatedAt
          });
        },
        message: "Workspace Task Run correlation is invalid"
      },
      {
        mutate(state: ReturnType<typeof createFixtureState>) {
          const { task } = addFixtureTaskRunCorrelation(state);
          state.artifacts.push({
            id: "artifact-invalid-run",
            workspaceId: state.workspace.id,
            ownerType: "task",
            ownerId: task.id,
            runId: "missing-run",
            type: "text",
            name: "Invalid provenance",
            content: "Invalid",
            createdAt: state.workspace.createdAt,
            updatedAt: state.workspace.updatedAt
          });
        },
        message: "Workspace Artifact Run correlation is invalid"
      }
    ];

    for (const testCase of cases) {
      const state = createFixtureState();
      testCase.mutate(state);
      expect(() => migrateAppState(state)).toThrow(testCase.message);
    }
  });

  it("migrates v2 state to the runtime contract ledgers", () => {
    const legacy = createInitialState(
      "00000000-0000-4000-8000-000000000001"
    ) as unknown as Record<string, unknown>;
    legacy.schemaVersion = 2;
    for (const key of [
      "providerAttempts",
      "evidenceReferences",
      "discussionCompressions",
      "discussionInterventions",
      "discussionContextRevisions",
      "modelPricing"
    ]) {
      delete legacy[key];
    }

    const migrated = migrateAppState(legacy);

    expect(migrated).toMatchObject({
      schemaVersion: 5,
      providerAttempts: [],
      evidenceReferences: [],
      discussionCompressions: [],
      discussionInterventions: [],
      discussionContextRevisions: [],
      modelPricing: []
    });
  });

  it("backfills legacy v3 compression provenance", () => {
    const state = createFixtureState() as unknown as Record<string, unknown>;
    state.schemaVersion = 3;
    const discussion = createFixtureDiscussion({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      conversationId: "30000000-0000-4000-8000-000000000001"
    });
    state.discussions = [
      discussion
    ];
    state.discussionCompressions = [
      {
        id: "legacy-compression",
        workspaceId: "00000000-0000-4000-8000-000000000001",
        discussionId: discussion.id,
        status: "completed",
        sourceRoundIds: [],
        sourceTurnIds: [],
        evidenceIds: [],
        content: "Legacy summary",
        unresolvedQuestions: [],
        minorityPositions: [],
        schemaVersion: 1,
        promptProfileVersion: "discussion-prompts.v1",
        contentHash: "legacy-content",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    const migrated = migrateAppState(state);

    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.discussionCompressions[0]).toMatchObject({
      sourceSpanHash: "legacy:legacy-content",
      strategy: "extractive",
      compressionProfileVersion: "legacy"
    });
  });

  it("backfills Sources, Chunks, and Discussion sourceIds", () => {
    const state = createFixtureState() as unknown as Record<string, unknown>;
    state.schemaVersion = 4;
    state.discussions = [
      createFixtureDiscussion({
        workspaceId: "00000000-0000-4000-8000-000000000001",
        conversationId: "30000000-0000-4000-8000-000000000001"
      })
    ];

    const migrated = migrateAppState(state);

    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.sources).toEqual([]);
    expect(migrated.chunks).toEqual([]);
    expect(migrated.discussions[0].sourceIds).toEqual([]);
  });

  it("does not mutate its input", () => {
    const legacy = structuredClone(
      createInitialState("00000000-0000-4000-8000-000000000001")
    ) as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.discussions;
    const original = structuredClone(legacy);

    migrateAppState(legacy);

    expect(legacy).toEqual(original);
  });

  it("rejects invalid legacy Artifact ownership", () => {
    const legacy = structuredClone(
      createInitialState("00000000-0000-4000-8000-000000000001")
    ) as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.discussions;
    legacy.artifacts = [
      {
        id: "artifact-invalid",
        workspaceId: "00000000-0000-4000-8000-000000000001",
        type: "text",
        name: "Invalid",
        content: "Missing owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    expect(() => migrateAppState(legacy)).toThrow(
      "Workspace Artifact owner is invalid"
    );
  });

  it("rejects invalid current Discussions", () => {
    const state = createInitialState(
      "00000000-0000-4000-8000-000000000001"
    );
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id
    });
    discussion.status = "unknown" as never;
    state.discussions.push(discussion);

    expect(() => migrateAppState(state)).toThrow(
      "Discussion status is invalid"
    );
  });

  it("rejects invalid Discussion correlations", () => {
    const duplicate = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: duplicate.workspace.id,
      conversationId: duplicate.conversations[0].id
    });
    duplicate.discussions.push(
      discussion,
      createFixtureDiscussion({
        id: "70000000-0000-4000-8000-000000000002",
        workspaceId: duplicate.workspace.id,
        conversationId: duplicate.conversations[0].id
      })
    );
    expect(() => migrateAppState(duplicate)).toThrow(
      "Conversation can have at most one active Discussion"
    );

    const danglingMessage = createFixtureState();
    danglingMessage.messages.push({
      id: "message-discussion",
      workspaceId: danglingMessage.workspace.id,
      conversationId: danglingMessage.conversations[0].id,
      discussionId: "missing-discussion",
      authorType: "system",
      authorId: "user",
      content: "Discussion event",
      status: "complete",
      createdAt: danglingMessage.workspace.createdAt,
      updatedAt: danglingMessage.workspace.updatedAt
    });
    expect(() => migrateAppState(danglingMessage)).toThrow(
      "Message references an unknown Discussion"
    );
  });

  it("rejects runtime records that contain credentials", () => {
    const state = createInitialState(
      "00000000-0000-4000-8000-000000000001"
    );
    state.providerAttempts.push({
      id: "attempt-invalid",
      workspaceId: state.workspace.id,
      purpose: "conversation",
      provider: "openai",
      modelId: "test-model",
      targetOrder: 0,
      attempt: 1,
      status: "succeeded",
      usage: { source: "unknown" },
      credential: "must-not-persist",
      startedAt: state.workspace.createdAt
    } as never);

    expect(() => migrateAppState(state)).toThrow(
      "Workspace providerAttempts are invalid"
    );
  });

  it("rejects invalid Employee fallback targets", () => {
    const state = createFixtureState();
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: "",
        modelId: "fallback-model"
      }
    ];

    expect(() => migrateAppState(state)).toThrow(
      "Workspace Employee fallback targets are invalid"
    );
  });

  it("rejects duplicate Employee fallback targets", () => {
    const state = createFixtureState();
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: state.employees[0].providerCredentialId,
        modelId: state.employees[0].modelId
      }
    ];

    expect(() => migrateAppState(state)).toThrow(
      "Workspace Employee fallback targets are invalid"
    );
  });

  it("rejects fallback links that cross Run boundaries", () => {
    const state = createFixtureState();
    const baseRun = {
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id,
      triggerMessageId: "trigger",
      memberSnapshot: [state.employees[0].id],
      status: "failed" as const,
      createdAt: state.workspace.createdAt
    };
    state.runs.push(
      { ...baseRun, id: "run-source" },
      { ...baseRun, id: "run-target" }
    );
    state.providerAttempts.push(
      {
        id: "attempt-source",
        workspaceId: state.workspace.id,
        runId: "run-source",
        purpose: "conversation",
        provider: "openai",
        modelId: "test-model",
        targetOrder: 0,
        attempt: 1,
        status: "failed",
        usage: { source: "unknown" },
        startedAt: state.workspace.createdAt
      },
      {
        id: "attempt-target",
        workspaceId: state.workspace.id,
        runId: "run-target",
        purpose: "conversation",
        provider: "openai",
        modelId: "test-model",
        targetOrder: 1,
        attempt: 1,
        status: "failed",
        fallbackFromAttemptId: "attempt-source",
        usage: { source: "unknown" },
        startedAt: state.workspace.createdAt
      }
    );

    expect(() => migrateAppState(state)).toThrow(
      "Workspace providerAttempts are invalid"
    );
  });

  it("rejects dangling context revision history references", () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    state.discussions.push(discussion);
    state.discussionContextRevisions.push({
      id: "context-invalid",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      roundId: discussion.rounds[0].id,
      turnId: discussion.rounds[0].turns[0].id,
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      safetyMarginTokens: 3_277,
      schemaOverheadTokens: 80,
      toolOverheadTokens: 20,
      inputTokens: 120,
      outputReserveTokens: 4_096,
      countSource: "estimated",
      contextHash: "context-invalid",
      roundIds: ["missing-round"],
      turnIds: [discussion.rounds[0].turns[0].id],
      messageIds: [],
      compressionIds: [],
      createdAt: state.workspace.createdAt
    });

    expect(() => migrateAppState(state)).toThrow(
      "Workspace discussionContextRevisions are invalid"
    );
  });

  it("rejects half-linked Discussion Task origins", () => {
    const state = createFixtureState();
    state.tasks.push({
      id: "task-discussion",
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id,
      discussionId: "discussion-1",
      title: "Half linked",
      goal: "Missing the Brief reference.",
      assigneeIds: [state.employees[0].id],
      status: "draft",
      history: [],
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });

    expect(() => migrateAppState(state)).toThrow(
      "Task Discussion origin is incomplete"
    );
  });

  it("rejects schema versions newer than this application", () => {
    const state = createInitialState(
      "00000000-0000-4000-8000-000000000001"
    );
    state.schemaVersion = 99;

    expect(() => migrateAppState(state)).toThrow(
      "Unsupported Workspace schema version"
    );
  });
});
