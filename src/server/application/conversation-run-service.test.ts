import { describe, expect, it } from "vitest";
import {
  ConversationRunService,
  parseMentions,
  providerTargetCompatibility
} from "@/server/application/conversation-run-service";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import { buildDiscussionView } from "@/server/application/discussion-view";
import { evidenceReferenceId } from "@/server/application/discussion-evidence";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import {
  createFixtureDiscussion,
  createFixtureModelPricing,
  createFixtureProviderAttempt,
  createFixtureState,
  createFixtureTurnPayload,
  discussionModelGateway,
  noopProviderRegistry,
  RecordingModelGateway,
  TEST_KEY,
  ToolCallingModelGateway
} from "@/server/test-support/fixtures";
import { MemoryStore } from "@/server/store/memory-store";
import { WorkspaceService } from "@/server/application/workspace-service";
import type { ModelGateway } from "@/server/application/model-gateway";
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolGateway
} from "@/server/application/tool-gateway";
import type {
  AppState,
  Approval,
  DiscussionRound
} from "@/server/domain/types";

describe("ConversationRun", () => {
  it("runs a Discussion phase in Participant order and links Turns to Messages", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const expectedResponse = JSON.stringify(
      createFixtureTurnPayload("cross_response", "response")
    );
    const engine = new RecordingModelGateway(() => [expectedResponse]);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    await store.update((current) => {
      current.messages.push({
        id: "unrelated-message",
        workspaceId: current.workspace.id,
        conversationId: "30000000-0000-4000-8000-000000000001",
        authorType: "user",
        authorId: "user",
        content: "UNRELATED CONVERSATION CONTEXT",
        status: "complete",
        createdAt: current.workspace.createdAt,
        updatedAt: current.workspace.updatedAt
      });
    });

    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: [...round.participantSnapshot].reverse(),
        context: "Alice established the initial position.",
        purpose: "Challenge the assumptions from the earlier phase."
      }
    );

    expect(started.run).toMatchObject({
      discussionId: discussion.id,
      discussionRound: round.roundNumber,
      memberSnapshot: round.participantSnapshot.map(
        (participant) => participant.employeeId
      )
    });
    expect(started.message).toMatchObject({
      authorType: "system",
      discussionId: discussion.id
    });
    expect(
      await store.read((current) =>
        current.messages.filter((message) => message.authorType === "user")
      )
    ).toEqual([
      expect.objectContaining({
        authorId: "user",
        content: "UNRELATED CONVERSATION CONTEXT"
      })
    ]);

    await runs.processRun(started.run.id);

    expect(engine.requests).toHaveLength(2);
    expect(
      engine.requests[0].messages?.some(
        (message) =>
          message.role === "assistant" &&
          message.turnId === discussion.rounds[0].turns[0].id
      )
    ).toBe(true);
    expect(engine.requests[0].prompt).not.toContain(
      "UNRELATED CONVERSATION CONTEXT"
    );
    expect(engine.requests[1].prompt).toContain(
      'Assistant: {"summary":"response"'
    );

    const persisted = await store.read((current) => {
      const currentDiscussion = current.discussions.find(
        (item) => item.id === discussion.id
      );
      const currentRound = currentDiscussion?.rounds.find(
        (item) => item.id === round.id
      );
      return {
        messages: current.messages.filter(
          (message) => message.discussionId === discussion.id
        ),
        turns: currentRound?.turns ?? []
      };
    });
    expect(
      persisted.messages.map((message) => [
        message.authorType,
        message.authorId,
        message.discussionTurnId
      ])
    ).toEqual([
      ["system", "system", undefined],
      [
        "employee",
        round.participantSnapshot[0].employeeId,
        persisted.turns[0].id
      ],
      [
        "employee",
        round.participantSnapshot[1].employeeId,
        persisted.turns[1].id
      ]
    ]);
    expect(persisted.turns).toMatchObject([
      {
        employeeId: round.participantSnapshot[0].employeeId,
        status: "completed",
        messageId: persisted.messages[1].id,
        content: expectedResponse
      },
      {
        employeeId: round.participantSnapshot[1].employeeId,
        status: "completed",
        messageId: persisted.messages[2].id,
        content: expectedResponse
      }
    ]);

    await expect(
      runs.startPhaseRun(
        "30000000-0000-4000-8000-000000000001",
        {
          discussionId: discussion.id,
          roundId: round.id,
          participantSnapshot: round.participantSnapshot,
          context: "Alice established the initial position.",
          purpose: "Challenge the assumptions from the earlier phase."
        }
      )
    ).rejects.toMatchObject({ code: "phase_run_exists" });
    expect(
      await store.read((current) => ({
        runIds: current.runs
          .filter((run) => run.discussionRound === round.roundNumber)
          .map((run) => run.id),
        turns:
          current.discussions
            .find((item) => item.id === discussion.id)
            ?.rounds.find((item) => item.id === round.id)?.turns ?? []
      }))
    ).toEqual({
      runIds: [started.run.id],
      turns: persisted.turns
    });
  });

  it("plans structured Discussion context and persists a revision", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const expectedResponse = JSON.stringify(
      createFixtureTurnPayload("cross_response", "planned response")
    );
    const engine = new RecordingModelGateway(() => [expectedResponse]);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine,
      {
        tokenCounter: (text) => Math.ceil(text.length / 4)
      }
    );

    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Alice established the initial position.",
        purpose: "Challenge the assumptions from the earlier phase."
      }
    );
    await runs.processRun(started.run.id);

    expect(engine.requests).toHaveLength(2);
    expect(engine.requests[0].systemPrompt).toContain("Role: analyst");
    expect(
      engine.requests[0].messages?.some(
        (message) =>
          message.role === "user" &&
          message.discussionId === discussion.id &&
          message.phase === "cross_response"
      )
    ).toBe(true);
    expect(
      engine.requests[0].messages?.some(
        (message) =>
          message.role === "assistant" &&
          message.discussionId === discussion.id &&
          message.turnId === discussion.rounds[0].turns[0].id
      )
    ).toBe(true);
    expect(
      engine.requests[0].messages?.some((message) =>
        message.content.includes("Alice established the initial position.")
      )
    ).toBe(true);

    const revisions = await store.read(
      (current) => current.discussionContextRevisions
    );
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      discussionId: discussion.id,
      roundId: round.id,
      countSource: "exact"
    });
    expect(revisions[0].inputTokens).toBeGreaterThan(0);
    expect(revisions[0].schemaOverheadTokens).toBeGreaterThan(0);
    expect(revisions[0].toolOverheadTokens).toBeGreaterThan(0);
    expect(revisions[0].safetyMarginTokens).toBeGreaterThan(0);
    expect(revisions[0].maxOutputTokens).toBe(4_096);
    expect(revisions[0].turnIds).toContain(discussion.rounds[0].turns[0].id);

    const view = await new DiscussionOrchestrator(
      store,
      runs
    ).getDiscussionView(discussion.id);
    expect(view.budget.context).toMatchObject({
      countSource: "exact",
      turnIds: revisions[1].turnIds
    });
  });

  it("rejects a Discussion Turn before the Provider when context cannot fit", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const engine = new RecordingModelGateway(() => [
      JSON.stringify(createFixtureTurnPayload("cross_response"))
    ]);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine,
      {
        modelContext: () => ({
          contextWindow: 64,
          maxOutputTokens: 32
        })
      }
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Alice established the initial position.",
        purpose: "Challenge the assumptions from the earlier phase."
      }
    );

    const failed = await runs.processRun(started.run.id);

    expect(engine.requests).toHaveLength(0);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "discussion_context_budget_exceeded"
    });
    const persisted = await store.read((current) => ({
      events: current.runEvents.filter((event) => event.runId === failed.id),
      discussionEvents:
        current.discussions.find((item) => item.id === discussion.id)?.events ??
        []
    }));
    expect(persisted.events).toContainEqual(
      expect.objectContaining({
        type: "model_error",
        payload: expect.objectContaining({
          code: "discussion_context_budget_exceeded"
        })
      })
    );
    expect(persisted.discussionEvents.map((event) => event.type)).toContain(
      "context_budget_rejected"
    );
  });

  it("compresses older Rounds when priority retention would exceed the budget", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const oldEvidenceAlias = "external:https://example.com/old-context";
    state.evidenceReferences.push({
      id: evidenceReferenceId(oldEvidenceAlias),
      workspaceId: state.workspace.id,
      kind: "external_source",
      sourceId: "https://example.com/old-context",
      createdAt: state.workspace.createdAt
    });
    const unresolvedTurnId = `${discussion.id}-unresolved-turn`;
    discussion.rounds.unshift({
      id: `${discussion.id}-unresolved-round`,
      roundNumber: -1,
      phase: "cross_response",
      status: "completed",
      participantSnapshot: structuredClone(discussion.participants),
      turns: [
        {
          id: unresolvedTurnId,
          employeeId: discussion.participants[0].employeeId,
          role: "analyst",
          order: 1,
          status: "completed",
          payload: {
            summary: "Unresolved question",
            claims: [],
            assumptions: [],
            risks: [],
            openQuestions: ["Should the migration be reversible?"],
            agreements: [],
            disagreements: [],
            corrections: []
          },
          createdAt: state.workspace.createdAt,
          completedAt: state.workspace.updatedAt
        }
      ],
      createdAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    const oldTurnId = `${discussion.id}-old-turn`;
    discussion.rounds.unshift({
      id: `${discussion.id}-old-round`,
      roundNumber: 0,
      phase: "positions",
      status: "completed",
      participantSnapshot: structuredClone(discussion.participants),
      turns: [
        {
          id: oldTurnId,
          employeeId: discussion.participants[0].employeeId,
          role: "analyst",
          order: 1,
          status: "completed",
          payload: {
            summary: `Old context ${"x".repeat(10_000)}`,
            claims: [
              {
                statement: "Old supported fact",
                kind: "fact",
                evidenceIds: [oldEvidenceAlias],
                confidence: "high"
              }
            ],
            assumptions: [],
            risks: [],
            openQuestions: []
          },
          createdAt: state.workspace.createdAt,
          completedAt: state.workspace.updatedAt
        }
      ],
      createdAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    const store = new MemoryStore(state);
    const engine = new RecordingModelGateway((request) =>
      request.purpose === "discussion_compression"
        ? [
            JSON.stringify({
              summary: "Compressed older history.",
              highlights: [
                {
                  statement: "Old supported fact",
                  evidenceIds: [oldEvidenceAlias]
                }
              ]
            })
          ]
        : [JSON.stringify(createFixtureTurnPayload("cross_response"))]
    );
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine,
      {
        modelContext: () => ({
          // Sized so priority retention still overflows (forcing
          // compression) while the compressed plan fits with the v3
          // prompt profile's extra convergence guidance.
          contextWindow: 5_700,
          maxOutputTokens: 200
        }),
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Prior phase context.",
        purpose: "Challenge the assumptions from the earlier phase."
      }
    );

    await runs.processRun(started.run.id);

    const revision = await store.read(
      (current) => current.discussionContextRevisions[0]
    );
    expect(revision.countSource).toBe("estimated");
    expect(revision.turnIds).toContain(discussion.rounds[2].turns[0].id);
    expect(revision.turnIds).toContain(unresolvedTurnId);
    expect(revision.turnIds).toContain(oldTurnId);
    expect(revision.compressionIds).toHaveLength(1);
    const compression = await store.read(
      (current) => current.discussionCompressions[0]
    );
    expect(compression).toMatchObject({
      strategy: "semantic",
      sourceSpanHash: expect.any(String),
      sourceTurnIds: expect.arrayContaining([oldTurnId]),
      evidenceIds: [evidenceReferenceId(oldEvidenceAlias)],
      content: expect.stringContaining("Old supported fact")
    });
    expect(compression.content).not.toContain("Compressed older history.");
    const attempts = await store.read((current) =>
      current.providerAttempts.filter(
        (attempt) =>
          attempt.discussionId === discussion.id &&
          attempt.purpose === "discussion_compression"
      )
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("succeeded");
    expect(
      await store.read((current) =>
        current.discussions
          .find((item) => item.id === discussion.id)
          ?.events?.map((event) => event.type)
      )
    ).toContain("compression_applied");
    expect(
      await store.read((current) =>
        current.discussions
          .find((item) => item.id === discussion.id)
          ?.events?.map((event) => event.type)
      )
    ).toContain("compression_used");
  });

  it("falls back to a deterministic digest when semantic compression fails", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    discussion.rounds.unshift({
      id: `${discussion.id}-old-round`,
      roundNumber: 0,
      phase: "positions",
      status: "completed",
      participantSnapshot: structuredClone(discussion.participants),
      turns: [
        {
          id: `${discussion.id}-old-turn`,
          employeeId: discussion.participants[0].employeeId,
          role: "analyst",
          order: 1,
          status: "completed",
          content: `Old context ${"x".repeat(30_000)}`,
          createdAt: state.workspace.createdAt,
          completedAt: state.workspace.updatedAt
        }
      ],
      createdAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    const store = new MemoryStore(state);
    const engine = new RecordingModelGateway((request) =>
      request.purpose === "discussion_compression"
        ? [
            JSON.stringify({
              highlights: [
                {
                  statement: "Invented unsupported claim",
                  evidenceIds: ["external:https://invalid.example"]
                }
              ]
            })
          ]
        : [JSON.stringify(createFixtureTurnPayload("cross_response"))]
    );
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine,
      {
        modelContext: () => ({
          contextWindow: 5_500,
          maxOutputTokens: 200
        }),
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Exercise deterministic compression.",
        purpose: "Compress old context."
      }
    );

    await runs.processRun(started.run.id);

    const compression = await store.read(
      (current) => current.discussionCompressions[0]
    );
    expect(compression.strategy).toBe("extractive");
    expect(compression.content).toContain(
      "Round 0 (positions)"
    );
    expect(compression.content).not.toContain(
      "Invented unsupported claim"
    );
    expect(
      await store.read((current) =>
        current.providerAttempts.filter(
          (attempt) =>
            attempt.purpose === "discussion_compression" &&
            attempt.discussionId === discussion.id
        )
      )
    ).toMatchObject([
      {
        status: "failed",
        errorKind: "malformed_output",
        errorCode: "discussion_compression_invalid"
      },
      {
        status: "failed",
        errorKind: "malformed_output",
        errorCode: "discussion_compression_invalid"
      }
    ]);
  });

  it("does not start a Turn after compression is cancelled", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    discussion.rounds.unshift({
      id: `${discussion.id}-old-round`,
      roundNumber: 0,
      phase: "positions",
      status: "completed",
      participantSnapshot: structuredClone(discussion.participants),
      turns: [
        {
          id: `${discussion.id}-old-turn`,
          employeeId: discussion.participants[0].employeeId,
          role: "analyst",
          order: 1,
          status: "completed",
          content: `Old context ${"x".repeat(30_000)}`,
          createdAt: state.workspace.createdAt,
          completedAt: state.workspace.updatedAt
        }
      ],
      createdAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    const store = new MemoryStore(state);
    let compressionStartedResolve: (() => void) | undefined;
    const compressionStarted = new Promise<void>((resolve) => {
      compressionStartedResolve = resolve;
    });
    const engine: ModelGateway = {
      async *run(request) {
        if (request.purpose !== "discussion_compression") {
          yield {
            type: "text_completed",
            text: JSON.stringify(
              createFixtureTurnPayload("cross_response")
            )
          };
          return;
        }
        compressionStartedResolve?.();
        await new Promise<void>((_, reject) => {
          if (request.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          request.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        });
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine,
      {
        modelContext: () => ({
          contextWindow: 5_500,
          maxOutputTokens: 200
        })
      }
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Exercise compression cancellation.",
        purpose: "Cancel before the Turn starts."
      }
    );

    const processing = runs.processRun(started.run.id);
    await compressionStarted;
    await runs.cancelRun(started.run.id);
    const cancelled = await processing;

    expect(cancelled.status).toBe("cancelled");
    expect(
      await store.read((current) =>
        current.messages.filter(
          (message) =>
            message.runId === started.run.id &&
            message.status === "streaming"
        )
      )
    ).toEqual([]);
  });

  it("includes applied interventions in structured Discussion context", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const intervention = {
      id: "intervention-context",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      kind: "material" as const,
      content: "Use payroll data as external validation.",
      status: "applied" as const,
      createdBy: "user",
      appliedPhase: "positions" as const,
      appliedRoundId: discussion.rounds[0].id,
      resultingDiscussionRevision: 1,
      appliedAt: state.workspace.updatedAt,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    };
    state.discussionInterventions.push(intervention);
    const store = new MemoryStore(state);
    const engine = new RecordingModelGateway(() => [
      JSON.stringify(createFixtureTurnPayload("cross_response"))
    ]);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Prior phase context.",
        purpose: "Challenge the assumptions from the earlier phase."
      }
    );

    await runs.processRun(started.run.id);

    expect(
      engine.requests[0].messages?.some(
        (message) =>
          message.kind === "user_intervention" &&
          message.interventionId === intervention.id &&
          message.content.includes(intervention.content)
      )
    ).toBe(true);
  });

  it("records provider attempts with exact usage and stable correlation", async () => {
    const state = createFixtureState();
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cachedInputTokens: 40,
            cacheWriteTokens: 12,
            cacheWrite1hTokens: 4,
            reasoningTokens: 10,
            totalTokens: 150,
            source: "provider"
          },
          providerRequestId: "provider-request-1",
          responseModel: "resolved-model"
        };
        yield { type: "text_completed", text: "recorded" };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice record this" }
    );

    await runs.processRun(started.run!.id);

    const persisted = await store.read((current) => ({
      attempt: current.providerAttempts.at(-1),
      events: current.runEvents.filter(
        (event) => event.runId === started.run!.id
      )
    }));
    expect(persisted.attempt).toMatchObject({
      runId: started.run!.id,
      purpose: "conversation",
      provider: "openai",
      modelId: "test-model",
      targetOrder: 0,
      attempt: 1,
      status: "succeeded",
      providerRequestId: "provider-request-1",
      responseModel: "resolved-model",
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cachedInputTokens: 40,
        cacheWriteTokens: 12,
        cacheWrite1hTokens: 4,
        reasoningTokens: 10,
        totalTokens: 150,
        source: "provider"
      }
    });
    expect(persisted.attempt?.completedAt).toBeDefined();
    expect(persisted.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "provider_attempt_started",
        "usage_recorded",
        "provider_attempt_completed"
      ])
    );
  });

  it("stamps the pricing snapshot and estimated cost when usage is recorded", async () => {
    const state = createFixtureState();
    state.modelPricing.push(
      createFixtureModelPricing({
        workspaceId: state.workspace.id,
        cachedInputMicrosPerMillionTokens: 300_000
      })
    );
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cachedInputTokens: 400_000,
            totalTokens: 1_100_000,
            source: "provider"
          }
        };
        yield { type: "text_completed", text: "priced" };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice price this" }
    );

    await runs.processRun(started.run!.id);

    const attempt = await store.read((current) =>
      current.providerAttempts.at(-1)
    );
    // 600k uncached input * 3.0 + 400k cached * 0.3 + 100k output * 15.0
    expect(attempt).toMatchObject({
      pricingId: "pricing-openai-test",
      estimatedCostMicros: 3_420_000
    });
  });

  it("records unknown cost when no pricing snapshot matches the attempt", async () => {
    const state = createFixtureState();
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            source: "provider"
          }
        };
        yield { type: "text_completed", text: "unpriced" };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice run without pricing" }
    );

    await runs.processRun(started.run!.id);

    const attempt = await store.read((current) =>
      current.providerAttempts.at(-1)
    );
    expect(attempt?.pricingId).toBeUndefined();
    expect(attempt?.estimatedCostMicros).toBeNull();
  });

  it("rejects the next Provider call without invoking it when the hard token budget would be exceeded", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    discussion.budget = { maxTotalTokens: 10 };
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "budget-used",
        workspaceId: state.workspace.id,
        discussionId: discussion.id,
        purpose: "discussion_turn",
        usage: {
          inputTokens: 5,
          outputTokens: 0,
          totalTokens: 5,
          source: "provider"
        }
      })
    );
    const store = new MemoryStore(state);
    const gateway = discussionModelGateway();
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Prior phase context.",
        purpose: "Challenge the earlier phase."
      }
    );

    await runs.processRun(started.run.id);

    expect(gateway.requests).toHaveLength(0);
    const persisted = await store.read((current) => ({
      run: current.runs.find((item) => item.id === started.run.id)!,
      round: current.discussions
        .find((item) => item.id === discussion.id)!
        .rounds.find((item) => item.id === round.id)!
    }));
    expect(persisted.run).toMatchObject({
      status: "interrupted",
      errorCode: "discussion_budget_exhausted"
    });
    expect(
      persisted.round.turns.every((turn) => turn.status !== "completed")
    ).toBe(true);
  });

  it("lets the current Turn finish but cancels the next one at the soft token threshold", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    discussion.budget = { maxTotalTokens: 100_000, softTotalTokens: 30 };
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 40,
            outputTokens: 0,
            totalTokens: 40,
            source: "provider"
          }
        };
        yield {
          type: "text_completed",
          text: JSON.stringify(createFixtureTurnPayload("cross_response"))
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Prior phase context.",
        purpose: "Challenge the earlier phase."
      }
    );

    await runs.processRun(started.run.id);

    const persisted = await store.read((current) => ({
      run: current.runs.find((item) => item.id === started.run.id)!,
      round: current.discussions
        .find((item) => item.id === discussion.id)!
        .rounds.find((item) => item.id === round.id)!
    }));
    expect(persisted.run.status).toBe("completed");
    const statuses = persisted.round.turns.map((turn) => turn.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("cancelled");
    const cancelled = persisted.round.turns.find(
      (turn) => turn.status === "cancelled"
    );
    expect(cancelled?.cancelReason).toBe("budget_exhausted");
  });

  it("interrupts the Run at the Turn boundary when the hard token budget is already met", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    discussion.budget = { maxTotalTokens: 30 };
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield {
          type: "usage",
          usage: {
            inputTokens: 40,
            outputTokens: 0,
            totalTokens: 40,
            source: "provider"
          }
        };
        yield {
          type: "text_completed",
          text: JSON.stringify(createFixtureTurnPayload("cross_response"))
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Prior phase context.",
        purpose: "Challenge the earlier phase."
      }
    );

    await runs.processRun(started.run.id);

    const persisted = await store.read((current) => ({
      run: current.runs.find((item) => item.id === started.run.id)!,
      round: current.discussions
        .find((item) => item.id === discussion.id)!
        .rounds.find((item) => item.id === round.id)!
    }));
    expect(persisted.run).toMatchObject({
      status: "interrupted",
      errorCode: "discussion_budget_exhausted"
    });
    const interrupted = persisted.round.turns.filter(
      (turn) => turn.status === "interrupted"
    );
    expect(interrupted.length).toBeGreaterThan(0);
    expect(interrupted[0].cancelReason).toBe("budget_exhausted");
  });

  it("records each provider call in a tool-using Turn", async () => {
    const store = new MemoryStoreFixture();
    const gateway: ModelGateway = {
      async *run() {
        yield { type: "provider_attempt_started", attempt: 1 };
        yield {
          type: "usage",
          usage: {
            inputTokens: 30,
            outputTokens: 10,
            totalTokens: 40,
            source: "provider"
          },
          providerRequestId: "provider-call-1"
        };
        yield { type: "provider_attempt_started", attempt: 2 };
        yield {
          type: "usage",
          usage: {
            inputTokens: 20,
            outputTokens: 5,
            totalTokens: 25,
            source: "provider"
          },
          providerRequestId: "provider-call-2"
        };
        yield { type: "text_completed", text: "done" };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice use a tool loop" }
    );

    await runs.processRun(started.run!.id);

    const attempts = await store.read((state) =>
      state.providerAttempts.filter(
        (attempt) => attempt.runId === started.run!.id
      )
    );
    expect(attempts).toMatchObject([
      {
        attempt: 1,
        status: "succeeded",
        providerRequestId: "provider-call-1",
        usage: { totalTokens: 40 }
      },
      {
        attempt: 2,
        status: "succeeded",
        providerRequestId: "provider-call-2",
        usage: { totalTokens: 25 }
      }
    ]);
  });

  it("records failed and retried provider attempts", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    let calls = 0;
    const engine: ModelGateway = {
      async *run() {
        calls += 1;
        if (calls === 1) {
          yield { type: "text_completed", text: "not-json" };
          return;
        }
        yield {
          type: "usage",
          usage: {
            inputTokens: 80,
            outputTokens: 20,
            totalTokens: 100,
            source: "provider"
          }
        };
        yield {
          type: "text_completed",
          text: JSON.stringify(
            createFixtureTurnPayload("cross_response")
          )
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Retry malformed output.",
        purpose: "Validate retries."
      }
    );

    await runs.processRun(started.run.id);

    const attempts = await store.read((current) =>
      current.providerAttempts.filter(
        (attempt) => attempt.runId === started.run.id
      )
    );
    expect(attempts.slice(0, 2)).toMatchObject([
      {
        attempt: 1,
        status: "failed",
        errorKind: "malformed_output",
        errorCode: "provider_malformed_output"
      },
      {
        attempt: 2,
        status: "succeeded",
        usage: {
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
          source: "provider"
        }
      }
    ]);
    expect(
      await store.read(
        (current) =>
          current.discussions
            .find((item) => item.id === discussion.id)
            ?.events?.map((event) => event.type) ?? []
      )
    ).toEqual(
      expect.arrayContaining([
        "provider_attempt_started",
        "usage_recorded",
        "provider_attempt_completed"
      ])
    );
  });

  it("regenerates fact claims without evidence and persists valid references", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    let calls = 0;
    const gateway: ModelGateway = {
      async *run() {
        calls += 1;
        const response = createFixtureTurnPayload(
          "cross_response",
          "evidence response"
        );
        response.claims =
          calls === 1
            ? [
                {
                  statement: "Unsupported fact",
                  kind: "fact",
                  confidence: "high"
                }
              ]
            : [
                {
                  statement: "Supported fact",
                  kind: "fact",
                  evidenceIds: ["external:https://example.com/evidence"],
                  confidence: "high"
                }
              ];
        yield { type: "text_completed", text: JSON.stringify(response) };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Validate evidence.",
        purpose: "Require evidence for facts."
      }
    );

    await runs.processRun(started.run.id);

    const persisted = await store.read((current) => ({
      attempts: current.providerAttempts.filter(
        (attempt) => attempt.runId === started.run.id
      ),
      references: current.evidenceReferences,
      discussion: current.discussions.find(
        (item) => item.id === discussion.id
      )!
    }));
    expect(persisted.attempts.slice(0, 2)).toMatchObject([
      {
        attempt: 1,
        status: "failed",
        errorKind: "malformed_output",
        errorCode: "discussion_evidence_invalid"
      },
      { attempt: 2, status: "succeeded" }
    ]);
    expect(persisted.references).toContainEqual(
      expect.objectContaining({
        kind: "external_source",
        sourceId: "https://example.com/evidence"
      })
    );
    expect(
      persisted.discussion.events?.map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "evidence_validation_failed",
        "evidence_validated"
      ])
    );
  });

  it("fails with a stable evidence error after one regeneration", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield {
          type: "text_completed",
          text: JSON.stringify(
            createFixtureTurnPayload("cross_response", "unsupported")
          ).replace('"confidence":"medium"', '"kind":"fact","confidence":"medium"')
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Reject unsupported facts.",
        purpose: "Require evidence."
      }
    );

    const failed = await runs.processRun(started.run.id);

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "discussion_evidence_invalid"
    });
    const attempts = await store.read((current) =>
      current.providerAttempts.filter(
        (attempt) => attempt.runId === started.run.id
      )
    );
    expect(attempts).toMatchObject([
      {
        status: "failed",
        errorKind: "malformed_output",
        errorCode: "discussion_evidence_invalid"
      },
      {
        status: "failed",
        errorKind: "malformed_output",
        errorCode: "discussion_evidence_invalid"
      }
    ]);
    expect(
      await store.read((current) =>
        current.runEvents
          .filter((event) => event.runId === started.run.id)
          .map((event) => event.type)
      )
    ).toContain("evidence_validation_failed");
    expect(
      await store.read((current) =>
        current.runEvents.find(
          (event) =>
            event.runId === started.run.id &&
            event.type === "run_error"
        )
      )
    ).toMatchObject({
      payload: {
        reason: "evidence_validation_failed",
        errorCode: "discussion_evidence_invalid"
      }
    });
  });

  it("aggregates attempt usage in the Discussion view", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    state.providerAttempts.push({
      id: "attempt-unknown",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      roundId: round.id,
      purpose: "discussion_turn",
      provider: "openai",
      modelId: "test-model",
      targetOrder: 0,
      attempt: 1,
      status: "failed",
      usage: { source: "unknown" },
      startedAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    state.providerAttempts.push({
      id: "attempt-estimated",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      roundId: round.id,
      purpose: "discussion_turn",
      provider: "openai",
      modelId: "test-model",
      targetOrder: 0,
      attempt: 3,
      status: "succeeded",
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        source: "estimated"
      },
      startedAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    state.providerAttempts.push({
      id: "attempt-known",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      roundId: round.id,
      purpose: "discussion_turn",
      provider: "openai",
      modelId: "test-model",
      targetOrder: 0,
      attempt: 2,
      status: "succeeded",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        source: "provider"
      },
      startedAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );

    const view = await new DiscussionOrchestrator(
      store,
      runs
    ).getDiscussionView(discussion.id);

    expect(view.usage).toMatchObject({
      source: "mixed",
      inputTokens: 17,
      outputTokens: 8,
      totalTokens: 25,
      attemptCount: 3,
      succeededAttemptCount: 2,
      failedAttemptCount: 1,
      unknownUsageAttemptCount: 1
    });
  });

  it("preserves Run failure outcomes and settles the phase Turn", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield {
          type: "error",
          message: "phase model failed",
          kind: "terminal"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "No prior response is available.",
        purpose: "Establish the initial positions."
      }
    );
    const turnIds = await store.read(
      (current) =>
        current.discussions
          .find((item) => item.id === discussion.id)
          ?.rounds.find((item) => item.id === round.id)
          ?.turns.map((turn) => turn.id) ?? []
    );

    const failed = await runs.processRun(started.run.id);

    expect(failed).toMatchObject({
      status: "failed",
      error: "phase model failed"
    });
    const persisted = await store.read((current) => ({
      messages: current.messages.filter(
        (message) => message.discussionId === discussion.id
      ),
      turns:
        current.discussions
          .find((item) => item.id === discussion.id)
          ?.rounds.find((item) => item.id === round.id)?.turns ?? []
    }));
    expect(persisted.messages.at(-1)).toMatchObject({
      authorType: "employee",
      authorId: round.participantSnapshot[0].employeeId,
      discussionTurnId: turnIds[0],
      status: "failed",
      content: ""
    });
    expect(persisted.turns).toMatchObject([
      {
        id: turnIds[0],
        status: "failed",
        messageId: persisted.messages.at(-1)?.id,
        validationError: "phase model failed"
      },
      {
        id: turnIds[1],
        status: "pending"
      }
    ]);
    expect(
      (await runs.listRunEvents(started.run.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "model_error",
        "employee_turn_failed",
        "run_error"
      ])
    );
  });

  it("retries an invalid Turn payload once and persists the parsed payload", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const valid = JSON.stringify(
      createFixtureTurnPayload("cross_response", "valid after retry")
    );
    let call = 0;
    const gateway: ModelGateway = {
      async *run() {
        call += 1;
        const text = call === 1 ? "not json" : valid;
        yield { type: "text_delta", delta: text };
        yield { type: "text_completed", text };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "No prior response is available.",
        purpose: "Establish the initial positions."
      }
    );

    const completed = await runs.processRun(started.run.id);

    expect(completed.status).toBe("completed");
    expect(call).toBe(3);
    const persisted = await store.read((current) => {
      const turn = current.discussions
        .find((item) => item.id === discussion.id)
        ?.rounds.find((item) => item.id === round.id)?.turns[0];
      const message = current.messages.find(
        (item) => item.id === turn?.messageId
      );
      return { turn, message };
    });
    expect(persisted.turn).toMatchObject({
      status: "completed",
      content: valid,
      payload: createFixtureTurnPayload(
        "cross_response",
        "valid after retry"
      )
    });
    expect(persisted.message).toMatchObject({
      status: "complete",
      content: valid
    });
  });

  it("fails a Turn after a second invalid payload and never stores a payload", async () => {
    const state = createFixtureState();
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run() {
        yield { type: "text_delta", delta: "still not json" };
        yield { type: "text_completed", text: "still not json" };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "No prior response is available.",
        purpose: "Establish the initial positions."
      }
    );

    const failed = await runs.processRun(started.run.id);

    expect(failed.status).toBe("failed");
    const turn = await store.read(
      (current) =>
        current.discussions
          .find((item) => item.id === discussion.id)
          ?.rounds.find((item) => item.id === round.id)?.turns[0]
    );
    expect(turn).toMatchObject({
      status: "failed",
      content: "still not json",
      validationError: "Discussion Turn response is not JSON"
    });
    expect(turn?.payload).toBeUndefined();
  });

  it("stores a Message without starting a Run when no Employee is mentioned", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const result = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "This is a note for everyone." }
    );

    expect(result.run).toBeNull();
    expect(result.message.status).toBe("complete");
    expect(engine.requests).toHaveLength(0);
  });

  it("keeps at most one active Run per Conversation", async () => {
    const store = new MemoryStoreFixture();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice first run" },
      { requestId: "request-one" }
    );
    expect(started.run?.requestId).toBe("request-one");

    await expect(
      runService.startTurn("30000000-0000-4000-8000-000000000001", {
        content: "@alice second run"
      })
    ).rejects.toMatchObject({ code: "active_run" });

    await runService.cancelRun(started.run!.id);
  });

  it("streams and persists a single Employee response", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway(() => ["Hello", " from Alice"]);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice summarize the launch risks" }
    );
    expect(started.run?.memberSnapshot).toEqual([
      "20000000-0000-4000-8000-000000000001"
    ]);

    const completed = await runService.processRun(started.run!.id);
    expect(completed.error).toBeUndefined();
    expect(completed.status).toBe("completed");
    expect(engine.requests[0]).toMatchObject({
      provider: "openai",
      credential: "test-api-key",
      modelId: "test-model"
    });

    const messages = await runService.listMessages(started.message.conversationId);
    expect(messages.at(-1)).toMatchObject({
      authorType: "employee",
      authorId: "20000000-0000-4000-8000-000000000001",
      content: "Hello from Alice",
      status: "complete"
    });

    const events = await runService.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "employee_turn_started",
      "skill_loaded",
      "provider_attempt_started",
      "message_delta",
      "message_delta",
      "provider_attempt_completed",
      "message_completed",
      "employee_turn_completed",
      "run_completed"
    ]);
  });

  it("exposes only Tools allowed by the Employee's Skills", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const alice = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice inspect the Tools" }
    );
    await runService.processRun(alice.run!.id);
    const bob = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@bob inspect the Tools" }
    );
    await runService.processRun(bob.run!.id);

    expect(engine.requests[0].tools.map((tool) => tool.name)).toEqual([
      "current_time",
      "fetch_url"
    ]);
    expect(engine.requests[1].tools).toEqual([]);
  });

  it("executes read-only Tools through the Tool Gateway and uses the result", async () => {
    const store = new MemoryStoreFixture();
    const calls: ToolExecutionRequest[] = [];
    const toolGateway: ToolGateway = {
      async execute(request) {
        calls.push(request);
        return {
          content: "2026-01-01T00:00:00.000Z",
          details: { source: "fake" }
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("current_time", {}, (content) => content),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice use the current time Tool" }
    );

    await runs.processRun(started.run!.id);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: { name: "current_time" },
      args: {},
      context: {
        employeeId: "20000000-0000-4000-8000-000000000001",
        allowedToolNames: ["current_time", "fetch_url"]
      }
    });
    const messages = await runs.listMessages(started.message.conversationId);
    expect(messages.at(-1)?.content).toBe(
      "The Tool returned 2026-01-01T00:00:00.000Z."
    );
    const events = await runs.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool_started", "tool_completed"])
    );
    expect(events.map((event) => event.type)).not.toContain("tool_error");
    expect(await store.read((state) => state.approvals)).toEqual([]);
  });

  it("reports denied Tool calls without executing them", async () => {
    const store = new MemoryStoreFixture();
    const toolGateway: ToolGateway = {
      async execute() {
        return {
          content: "This Tool is not allowed for this Employee.",
          isError: true,
          errorKind: "unauthorized"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("current_time", {}, () => "denied"),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice use a denied Tool" }
    );

    await runs.processRun(started.run!.id);

    const events = await runs.listRunEvents(started.run!.id);
    expect(
      events.find((event) => event.type === "tool_completed")?.payload
    ).toMatchObject({ isError: true, errorKind: "unauthorized" });
    expect(
      events.find((event) => event.type === "tool_error")?.payload
    ).toMatchObject({ errorKind: "unauthorized" });
  });

  it("reports Tool schema failures without executing the Tool", async () => {
    const store = new MemoryStoreFixture();
    const toolGateway: ToolGateway = {
      async execute() {
        return {
          content: "Invalid Tool arguments.",
          isError: true,
          errorKind: "validation"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("fetch_url", {}, () => "invalid"),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice call fetch_url without a URL" }
    );

    await runs.processRun(started.run!.id);

    const events = await runs.listRunEvents(started.run!.id);
    expect(
      events.find((event) => event.type === "tool_error")?.payload
    ).toMatchObject({ errorKind: "validation" });
  });

  it("records Tool cancellation separately from completion", async () => {
    const store = new MemoryStoreFixture();
    const toolGateway: ToolGateway = {
      execute(request) {
        return new Promise<ToolExecutionResult>((resolve) => {
          if (request.signal?.aborted) {
            resolve({
              content: "Tool call cancelled.",
              isError: true,
              errorKind: "cancelled"
            });
            return;
          }
          request.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                content: "Tool call cancelled.",
                isError: true,
                errorKind: "cancelled"
              }),
            { once: true }
          );
        });
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("current_time", {}, () => "cancelled"),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice wait inside a Tool" }
    );
    const processing = runs.processRun(started.run!.id);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const startedTool = await store.read((state) =>
        state.runEvents.some(
          (event) =>
            event.runId === started.run!.id && event.type === "tool_started"
        )
      );
      if (startedTool) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await runs.cancelRun(started.run!.id);
    await processing;

    expect((await runs.getRunById(started.run!.id))?.status).toBe("cancelled");
    expect(
      (await runs.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "tool_started",
        "tool_completed",
        "tool_cancelled"
      ])
    );
  });

  it("retries a transient model failure when no output was produced", async () => {
    const store = new MemoryStoreFixture();
    let attempts = 0;
    const gateway: ModelGateway = {
      async *run() {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: "error",
            message: "temporary model failure",
            kind: "retryable"
          };
          return;
        }
        yield { type: "text_delta", delta: "recovered" };
        yield { type: "text_completed", text: "recovered" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice retry this" }
    );

    const completed = await runService.processRun(started.run!.id);

    expect(completed.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(
      (await runService.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "model_error",
        "provider_retry_scheduled"
      ])
    );
    expect(
      (await store.read((state) =>
        state.runEvents.find(
          (event) =>
            event.runId === started.run!.id &&
            event.type === "provider_retry_scheduled"
        )
      ))?.payload
    ).toMatchObject({
      nextAttempt: 2,
      delayMs: 500,
      failureKind: "retryable"
    });
  });

  it("fails over to an ordered fallback target after retries", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: fallbackProvider.id,
        modelId: "fallback-model"
      }
    ];
    const store = new MemoryStore(state);
    const requests: Array<{ provider: string; modelId: string }> = [];
    const gateway: ModelGateway = {
      async *run(request) {
        requests.push({
          provider: request.provider,
          modelId: request.modelId
        });
        if (request.provider === "openai") {
          yield {
            type: "error",
            message: "temporary model failure",
            kind: "retryable"
          };
          return;
        }
        yield { type: "text_completed", text: "fallback response" };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        maxProviderAttempts: 2,
        modelContext: fallbackModelContext,
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice survive the outage" }
    );

    const completed = await runs.processRun(started.run!.id);

    expect(completed.status).toBe("completed");
    expect(requests).toEqual([
      { provider: "openai", modelId: "test-model" },
      { provider: "openai", modelId: "test-model" },
      { provider: "anthropic", modelId: "fallback-model" }
    ]);
    const persisted = await store.read((current) => ({
      attempts: current.providerAttempts.filter(
        (attempt) => attempt.runId === started.run!.id
      ),
      events: current.runEvents.filter(
        (event) => event.runId === started.run!.id
      ),
      messages: current.messages.filter(
        (message) => message.runId === started.run!.id
      )
    }));
    expect(persisted.attempts).toMatchObject([
      { targetOrder: 0, attempt: 1, status: "failed" },
      { targetOrder: 0, attempt: 2, status: "failed" },
      {
        targetOrder: 1,
        attempt: 3,
        status: "succeeded",
        provider: "anthropic",
        modelId: "fallback-model",
        fallbackFromAttemptId: persisted.attempts[1].id
      }
    ]);
    expect(persisted.messages.at(-1)).toMatchObject({
      content: "fallback response",
      status: "complete"
    });
    expect(
      persisted.events.find(
        (event) => event.type === "provider_fallback_started"
      )?.payload
    ).toMatchObject({
      fromAttemptId: persisted.attempts[1].id,
      fromTargetOrder: 0,
      toTargetOrder: 1,
      provider: "anthropic",
      modelId: "fallback-model",
      reason: "provider_retryable"
    });
    expect(JSON.stringify(persisted)).not.toContain("test-api-key");
    expect(JSON.stringify(persisted)).not.toContain("fallback-api-key");
  });

  it("does not fail over after visible output has started", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: fallbackProvider.id,
        modelId: "fallback-model"
      }
    ];
    const store = new MemoryStore(state);
    let calls = 0;
    const gateway: ModelGateway = {
      async *run() {
        calls += 1;
        yield { type: "text_delta", delta: "partial" };
        yield {
          type: "error",
          message: "retryable after visible output",
          kind: "retryable"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        modelContext: fallbackModelContext,
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice do not duplicate this" }
    );

    const failed = await runs.processRun(started.run!.id);

    expect(failed.status).toBe("failed");
    expect(calls).toBe(1);
    expect(
      (await runs.listRunEvents(started.run!.id)).map((event) => event.type)
    ).not.toContain("provider_fallback_started");
  });

  it("records fallback use in Discussion history", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    const fallback = {
      providerCredentialId: fallbackProvider.id,
      modelId: "fallback-model"
    };
    for (const employee of state.employees) {
      employee.fallbackTargets = [fallback];
    }
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const gateway: ModelGateway = {
      async *run(request) {
        if (request.provider === "openai") {
          yield {
            type: "error",
            message: "primary provider unavailable",
            kind: "retryable"
          };
          return;
        }
        yield {
          type: "text_completed",
          text: JSON.stringify(
            createFixtureTurnPayload("cross_response")
          )
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        maxProviderAttempts: 1,
        modelContext: fallbackModelContext
      }
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Fail over safely.",
        purpose: "Exercise fallback visibility."
      }
    );

    const completed = await runs.processRun(started.run.id);

    expect(completed.status).toBe("completed");
    expect(
      await store.read(
        (current) =>
          current.discussions
            .find((item) => item.id === discussion.id)
            ?.events?.map((event) => event.type) ?? []
      )
    ).toContain("provider_fallback_started");
    expect(
      await store.read((current) =>
        current.providerAttempts
          .filter((attempt) => attempt.runId === started.run.id)
          .map((attempt) => attempt.targetOrder)
      )
    ).toEqual([0, 1, 0, 1]);
  });

  it("plans Discussion context for a larger fallback when the primary cannot fit", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    const fallback = {
      providerCredentialId: fallbackProvider.id,
      modelId: "fallback-model"
    };
    for (const employee of state.employees) {
      employee.fallbackTargets = [fallback];
    }
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const requests: string[] = [];
    const gateway: ModelGateway = {
      async *run(request) {
        requests.push(request.modelId);
        yield {
          type: "text_completed",
          text: JSON.stringify(
            createFixtureTurnPayload("cross_response")
          )
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        modelContext: ({ provider }) =>
          provider === "openai"
            ? {
                contextWindow: 1_000,
                maxOutputTokens: 256,
                available: true,
                supportsStructuredOutput: true
              }
            : fallbackModelContext()
      }
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "Use the larger fallback model.",
        purpose: "Exercise context-aware target selection."
      }
    );

    const completed = await runs.processRun(started.run.id);

    expect(completed.status).toBe("completed");
    expect(requests).toEqual(["fallback-model", "fallback-model"]);
    expect(
      await store.read((current) =>
        current.providerAttempts
          .filter((attempt) => attempt.runId === started.run.id)
          .map((attempt) => attempt.targetOrder)
      )
    ).toEqual([1, 1]);
    expect(
      await store.read(
        (current) =>
          current.discussions
            .find((item) => item.id === discussion.id)
            ?.events?.some(
              (event) => event.type === "provider_target_skipped"
            ) ?? false
      )
    ).toBe(true);
    const view = await store.read((current) =>
      buildDiscussionView(current, discussion.id)
    );
    expect(view.fallbacks).toContainEqual(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "fallback-model",
        toTargetOrder: 1
      })
    );
  });

  it("fails with target exhaustion when no Discussion target is compatible", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    for (const employee of state.employees) {
      employee.fallbackTargets = [
        {
          providerCredentialId: fallbackProvider.id,
          modelId: "fallback-model"
        }
      ];
    }
    const { discussion, round } = addFixturePhase(state);
    const store = new MemoryStore(state);
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway(),
      {
        modelContext: () => ({
          contextWindow: 32_000,
          maxOutputTokens: 4_000,
          available: false,
          supportsStructuredOutput: false
        })
      }
    );
    const started = await runs.startPhaseRun(
      "30000000-0000-4000-8000-000000000001",
      {
        discussionId: discussion.id,
        roundId: round.id,
        participantSnapshot: round.participantSnapshot,
        context: "No compatible target exists.",
        purpose: "Exercise target exhaustion."
      }
    );

    const failed = await runs.processRun(started.run.id);

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "provider_targets_exhausted"
    });
  });

  it("reports target exhaustion after all safe targets fail", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: fallbackProvider.id,
        modelId: "fallback-model"
      }
    ];
    const store = new MemoryStore(state);
    let calls = 0;
    const gateway: ModelGateway = {
      async *run() {
        calls += 1;
        yield {
          type: "error",
          message: "target terminal failure",
          kind: "terminal"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        maxProviderAttempts: 1,
        modelContext: fallbackModelContext
      }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice exhaust every target" }
    );

    const failed = await runs.processRun(started.run!.id);

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "provider_targets_exhausted"
    });
    expect(calls).toBe(2);
    expect(
      await store.read((current) =>
        current.providerAttempts
          .filter((attempt) => attempt.runId === started.run!.id)
          .map((attempt) => attempt.targetOrder)
      )
    ).toEqual([0, 1]);
  });

  it("does not replay an ambiguous Provider failure", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: fallbackProvider.id,
        modelId: "fallback-model"
      }
    ];
    const store = new MemoryStore(state);
    let calls = 0;
    const gateway: ModelGateway = {
      async *run() {
        calls += 1;
        yield {
          type: "error",
          message: "opaque transport failure",
          kind: "unknown"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        modelContext: fallbackModelContext,
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice do not replay an ambiguous call" }
    );

    const failed = await runs.processRun(started.run!.id);

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "provider_ambiguous"
    });
    expect(calls).toBe(1);
    expect(
      await store.read((current) =>
        current.providerAttempts.find(
          (attempt) => attempt.runId === started.run!.id
        )
      )
    ).toMatchObject({
      status: "ambiguous",
      errorKind: "unknown",
      errorCode: "provider_ambiguous"
    });
  });

  it("skips an unavailable fallback before making a Provider call", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: fallbackProvider.id,
        modelId: "missing-fallback-model"
      }
    ];
    const store = new MemoryStore(state);
    const requests: string[] = [];
    const gateway: ModelGateway = {
      async *run(request) {
        requests.push(request.modelId);
        yield {
          type: "error",
          message: "primary unavailable",
          kind: "retryable"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        maxProviderAttempts: 1,
        modelContext: ({ modelId }) =>
          modelId === "missing-fallback-model"
            ? {
                contextWindow: 32_000,
                maxOutputTokens: 4_000,
                available: false
              }
            : {
                contextWindow: 128_000,
                maxOutputTokens: 8_000,
                available: true,
                supportsStructuredOutput: true
              }
      }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice skip missing target" }
    );

    const failed = await runs.processRun(started.run!.id);

    expect(failed.errorCode).toBe("provider_targets_exhausted");
    expect(requests).toEqual(["test-model"]);
    expect(
      await store.read((current) =>
        current.runEvents.filter(
          (event) =>
            event.runId === started.run!.id &&
            event.type === "provider_target_skipped"
        )
      )
    ).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          targetOrder: 1,
          reason: "model_unavailable"
        })
      })
    );
  });

  it("rejects fallback targets that cannot satisfy structured output or context", () => {
    const plan = {
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      toolOverheadTokens: 500,
      inputTokens: 12_000
    } as Parameters<typeof providerTargetCompatibility>[1];

    expect(
      providerTargetCompatibility(
        {
          contextWindow: 128_000,
          maxOutputTokens: 8_000,
          available: true,
          supportsStructuredOutput: false
        },
        plan,
        { requireCapabilities: true }
      )
    ).toMatchObject({
      compatible: false,
      reason: "structured_output_unsupported"
    });
    expect(
      providerTargetCompatibility(
        {
          contextWindow: 16_000,
          maxOutputTokens: 4_000,
          available: true,
          supportsStructuredOutput: true
        },
        plan
      )
    ).toMatchObject({
      compatible: false,
      reason: "context_incompatible"
    });
    expect(
      providerTargetCompatibility(
        {
          contextWindow: 4_000,
          maxOutputTokens: 1_000,
          available: true,
          supportsStructuredOutput: true
        },
        undefined,
        {
          requireCapabilities: true,
          inputTokens: 3_500,
          toolOverheadTokens: 200
        }
      )
    ).toMatchObject({
      compatible: false,
      reason: "context_incompatible"
    });
  });

  it("cancels a Run while it is waiting to retry", async () => {
    const store = new MemoryStoreFixture();
    let calls = 0;
    let retrySleepStarted: (() => void) | undefined;
    const retrySleep = new Promise<void>((resolve) => {
      retrySleepStarted = resolve;
    });
    const gateway: ModelGateway = {
      async *run() {
        calls += 1;
        yield {
          type: "error",
          message: "temporary model failure",
          kind: "retryable"
        };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        sleep: async () => {
          retrySleepStarted?.();
          await new Promise(() => undefined);
        },
        retryRandom: () => 0
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice cancel during retry" }
    );

    const processing = runService.processRun(started.run!.id);
    await retrySleep;
    await runService.cancelRun(started.run!.id);
    const cancelled = await processing;

    expect(cancelled.status).toBe("cancelled");
    expect(calls).toBe(1);
    expect(
      await store.read((state) =>
        state.runEvents.some(
          (event) =>
            event.runId === started.run!.id &&
            event.type === "provider_retry_scheduled"
        )
      )
    ).toBe(true);
  });

  it.each([
    { kind: "terminal" as const, expectedCode: "provider_terminal" },
    { kind: "unknown" as const, expectedCode: "provider_ambiguous" }
  ])(
    "does not retry a $kind Provider failure",
    async ({ kind, expectedCode }) => {
      const store = new MemoryStoreFixture();
      let calls = 0;
      const gateway: ModelGateway = {
        async *run() {
          calls += 1;
          yield {
            type: "error",
            message: `${kind} provider failure`,
            kind
          };
        }
      };
      const runService = new ConversationRunService(
        store,
        new AesCredentialCipher(TEST_KEY),
        gateway
      );
      const started = await runService.startTurn(
        "30000000-0000-4000-8000-000000000001",
        { content: "@alice fail without retry" }
      );

      const failed = await runService.processRun(started.run!.id);

      expect(failed).toMatchObject({
        status: "failed",
        errorCode: expectedCode
      });
      expect(calls).toBe(1);
      expect(
        (await runService.listRunEvents(started.run!.id)).map(
          (event) => event.type
        )
      ).not.toContain("provider_retry_scheduled");
    }
  );

  it("keeps partial output when a model fails after streaming starts", async () => {
    const store = new MemoryStoreFixture();
    const gateway: ModelGateway = {
      async *run() {
        yield { type: "text_delta", delta: "partial output" };
        yield {
          type: "error",
          message: "model failed after output",
          kind: "terminal"
        };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice fail after output" }
    );

    const failed = await runService.processRun(started.run!.id);
    const messages = await runService.listMessages(started.message.conversationId);

    expect(failed.status).toBe("failed");
    expect(messages.at(-1)).toMatchObject({
      content: "partial output",
      status: "failed"
    });
    expect(
      (await runService.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "employee_turn_partial",
        "model_error",
        "run_error"
      ])
    );
    expect(
      await store.read((state) =>
        state.providerAttempts.filter(
          (attempt) => attempt.runId === started.run!.id
        )
      )
    ).toMatchObject([
      {
        status: "failed",
        errorKind: "terminal",
        errorCode: "provider_terminal"
      }
    ]);
  });

  it("retries rate-limited calls after the requested delay", async () => {
    const store = new MemoryStoreFixture();
    let calls = 0;
    const gateway: ModelGateway = {
      async *run() {
        calls += 1;
        if (calls === 1) {
          yield {
            type: "error",
            message: "rate limited",
            kind: "rate_limited",
            code: "provider_rate_limited",
            retryAfterMs: 750
          };
          return;
        }
        yield { type: "text_completed", text: "recovered" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice rate limit" }
    );

    const completed = await runService.processRun(started.run!.id);

    expect(completed.status).toBe("completed");
    expect(calls).toBe(2);
    expect(
      (await store.read((state) =>
        state.runEvents.find(
          (event) =>
            event.runId === started.run!.id &&
            event.type === "provider_retry_scheduled"
        )
      ))?.payload
    ).toMatchObject({
      failureKind: "rate_limited",
      retryAfterMs: 750,
      delayMs: 750
    });
  });

  it("times out a Provider call without exceeding the attempt limit", async () => {
    const store = new MemoryStoreFixture();
    const gateway: ModelGateway = {
      async *run() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield { type: "text_completed", text: "late" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        maxProviderAttempts: 1,
        providerTimeoutMs: 10
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice timeout" }
    );

    const failed = await runService.processRun(started.run!.id);

    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout"
    });
    expect(
      await store.read((state) =>
        state.providerAttempts.filter(
          (attempt) => attempt.runId === started.run!.id
        )
      )
    ).toMatchObject([
      {
        status: "failed",
        errorKind: "timeout",
        errorCode: "provider_timeout"
      }
    ]);
  });

  it("aborts a Provider iterator that ignores its signal", async () => {
    const store = new MemoryStoreFixture();
    const gateway: ModelGateway = {
      async *run() {
        await new Promise(() => undefined);
        yield { type: "text_completed", text: "never" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        maxProviderAttempts: 1,
        providerTimeoutMs: 20
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice ignored timeout" }
    );
    const before = Date.now();

    const failed = await runService.processRun(started.run!.id);

    expect(Date.now() - before).toBeLessThan(500);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "provider_timeout"
    });
  });

  it("does not retry after a Tool side effect has started", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: fallbackProvider.id,
        modelId: "fallback-model"
      }
    ];
    const store = new MemoryStore(state);
    let calls = 0;
    const gateway: ModelGateway = {
      async *run() {
        calls += 1;
        yield {
          type: "tool_started",
          toolCallId: "unsafe-tool",
          toolName: "current_time",
          args: {}
        };
        yield {
          type: "error",
          message: "retryable after side effect",
          kind: "retryable"
        };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway,
      {
        modelContext: fallbackModelContext,
        sleep: async () => undefined,
        retryRandom: () => 0
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice tool then fail" }
    );

    const failed = await runService.processRun(started.run!.id);

    expect(failed.status).toBe("failed");
    expect(calls).toBe(1);
    expect(
      await store.read((state) =>
        state.providerAttempts.filter(
          (attempt) => attempt.runId === started.run!.id
        )
      )
    ).toHaveLength(1);
    expect(
      (await runService.listRunEvents(started.run!.id)).map(
        (event) => event.type
      )
    ).not.toContain("provider_retry_scheduled");
    expect(
      (await runService.listRunEvents(started.run!.id)).map(
        (event) => event.type
      )
    ).not.toContain("provider_fallback_started");
  });

  it("executes @all members sequentially and gives later members earlier responses", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway(() => ["response"]);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@all draft the launch brief" }
    );
    await runService.processRun(started.run!.id);

    expect(engine.requests).toHaveLength(2);
    expect(engine.requests[0].systemPrompt).toContain("You are Alice");
    expect(engine.requests[1].systemPrompt).toContain("You are Bob");
    expect(engine.requests[1].prompt).toContain("Alice: response");
  });

  it("keeps the @all member snapshot when the Conversation changes mid-Run", async () => {
    const store = new MemoryStoreFixture();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: import("@/server/application/model-gateway").ModelRequest[] =
      [];
    const gateway: ModelGateway = {
      async *run(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text_delta", delta: "Alice response" };
          yield { type: "text_completed", text: "Alice response" };
          await firstGate;
        } else {
          yield { type: "text_delta", delta: "Bob response" };
          yield { type: "text_completed", text: "Bob response" };
        }
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@all work together" }
    );
    const processing = runService.processRun(started.run!.id);
    for (let attempt = 0; attempt < 20 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await workspace.updateConversationMembers(
      "30000000-0000-4000-8000-000000000001",
      ["20000000-0000-4000-8000-000000000001"]
    );
    expect(
      await store.read(
        (state) =>
          state.conversations.find(
            (conversation) =>
              conversation.id === "30000000-0000-4000-8000-000000000001"
          )?.memberIds
      )
    ).toEqual(["20000000-0000-4000-8000-000000000001"]);
    releaseFirst?.();
    await processing;

    expect(requests).toHaveLength(2);
    expect(requests[1].systemPrompt).toContain("You are Bob");
    expect(requests[1].prompt).toContain("Alice: Alice response");
  });

  it("lets an assigned Employee move a Task and includes Task context", async () => {
    const state = createFixtureState();
    const skillId = "40000000-0000-4000-8000-000000000003";
    state.skills.push({
      id: skillId,
      workspaceId: state.workspace.id,
      name: "Task worker",
      description: "Updates assigned Tasks.",
      instructions: "Update the assigned Task when work starts.",
      inputs: ["task"],
      outputs: ["status"],
      toolNames: ["update_task"],
      builtIn: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.employees[0].skillIds.push(skillId);
    const store = new MemoryStore(state);
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Implement Task flow",
        goal: "Move the Task to in progress.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const captured: import("@/server/application/model-gateway").ModelRequest[] =
      [];
    const gateway: ModelGateway = {
      async *run(request) {
        captured.push(request);
        const tool = request.tools.find((item) => item.name === "update_task");
        if (!tool) throw new Error("update_task Tool was not available");
        for (const status of ["in_progress", "blocked", "review"]) {
          await tool.execute("tool-call", {
            taskId: task.id,
            status
          });
        }
        yield { type: "text_delta", delta: "Task started." };
        yield { type: "text_completed", text: "Task started." };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice start the assigned Task" }
    );

    await runs.processRun(started.run!.id);

    const updated = await store.read((current) =>
      current.tasks.find((item) => item.id === task.id)
    );
    expect(updated?.status).toBe("review");
    expect(updated?.history.map((entry) => entry.status)).toEqual([
      "draft",
      "in_progress",
      "blocked",
      "review"
    ]);
    expect(updated?.history.at(-1)?.actorId).toBe(
      "20000000-0000-4000-8000-000000000001"
    );
    expect(captured[0].prompt).toContain(task.id);
    expect(captured[0].prompt).toContain("Implement Task flow");
    expect(captured[0].prompt).toContain("Move the Task to in progress.");

    const employeeTool = captured[0].tools.find(
      (item) => item.name === "update_task"
    );
    if (!employeeTool) throw new Error("update_task Tool was not available");
    await expect(
      employeeTool.execute("tool-call", {
        taskId: task.id,
        status: "completed"
      })
    ).resolves.toMatchObject({
      isError: true,
      errorKind: "validation"
    });
    await expect(
      employeeTool.execute("tool-call", {
        taskId: task.id,
        status: "cancelled"
      })
    ).resolves.toMatchObject({
      isError: true,
      errorKind: "validation"
    });
    expect(
      (await store.read((current) =>
        current.tasks.find((item) => item.id === task.id)
      ))?.status
    ).toBe("review");
  });

  it("lets an assigned Employee publish supported Task Artifacts", async () => {
    const state = createFixtureState();
    const skillId = "40000000-0000-4000-8000-000000000004";
    state.skills.push({
      id: skillId,
      workspaceId: state.workspace.id,
      name: "Artifact publisher",
      description: "Publishes structured Task results.",
      instructions: "Attach each requested result to the assigned Task.",
      inputs: ["result"],
      outputs: ["artifact"],
      toolNames: ["update_task", "attach_artifact"],
      builtIn: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.employees[0].skillIds.push(skillId);
    const store = new MemoryStore(state);
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Publish Task results",
        goal: "Attach all supported result types.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const gateway: ModelGateway = {
      async *run(request) {
        const tool = request.tools.find(
          (item) => item.name === "attach_artifact"
        );
        if (!tool) throw new Error("attach_artifact Tool was not available");
        for (const [type, name, content] of [
          ["text", "Notes", "Plain findings."],
          ["markdown", "Brief", "# Findings"],
          ["json", "Metrics", JSON.stringify({ confidence: 0.9 })]
        ]) {
          await tool.execute(`tool-${type}`, {
            taskId: task.id,
            type,
            name,
            content
          });
        }
        const updateTask = request.tools.find(
          (item) => item.name === "update_task"
        );
        if (!updateTask) throw new Error("update_task Tool was not available");
        await updateTask.execute("task-review", {
          taskId: task.id,
          status: "review"
        });
        yield { type: "text_delta", delta: "Artifacts published." };
        yield { type: "text_completed", text: "Artifacts published." };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTask(task.id);

    await runs.processRun(started.run.id);

    const persisted = await store.read((current) => ({
      artifacts: current.artifacts.map((artifact) => ({
        type: artifact.type,
        name: artifact.name,
        ownerType: artifact.ownerType,
        ownerId: artifact.ownerId,
        runId: artifact.runId
      })),
      actions:
        current.tasks
          .find((item) => item.id === task.id)
          ?.history.filter((entry) => entry.action === "artifact_created")
          .map((entry) => entry.actorId) ?? [],
      status: current.tasks.find((item) => item.id === task.id)?.status
    }));
    expect(persisted.artifacts).toEqual([
      {
        type: "text",
        name: "Notes",
        ownerType: "task",
        ownerId: task.id,
        runId: started.run.id
      },
      {
        type: "markdown",
        name: "Brief",
        ownerType: "task",
        ownerId: task.id,
        runId: started.run.id
      },
      {
        type: "json",
        name: "Metrics",
        ownerType: "task",
        ownerId: task.id,
        runId: started.run.id
      }
    ]);
    expect(persisted.actions).toEqual([
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001"
    ]);
    expect(persisted.status).toBe("review");
    expect(
      (await runs.listRunEvents(started.run.id)).filter(
        (event) => event.type === "artifact_created"
      )
    ).toHaveLength(3);
  });

  it("rejects invalid Employee Task Artifacts", async () => {
    const state = createFixtureState();
    const skillId = "40000000-0000-4000-8000-000000000005";
    state.skills.push({
      id: skillId,
      workspaceId: state.workspace.id,
      name: "Artifact publisher",
      description: "Publishes structured Task results.",
      instructions: "Attach requested results to the assigned Task.",
      inputs: ["result"],
      outputs: ["artifact"],
      toolNames: ["attach_artifact"],
      builtIn: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.employees[0].skillIds.push(skillId);
    const store = new MemoryStore(state);
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Validate Task results",
        goal: "Reject invalid result payloads.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const failures: ToolExecutionResult[] = [];
    const gateway: ModelGateway = {
      async *run(request) {
        const tool = request.tools.find(
          (item) => item.name === "attach_artifact"
        );
        if (!tool) throw new Error("attach_artifact Tool was not available");
        for (const args of [
          {
            taskId: task.id,
            type: "binary",
            name: "Binary",
            content: "AAECAw=="
          },
          {
            taskId: task.id,
            type: "json",
            name: "Broken JSON",
            content: "{"
          },
          {
            taskId: task.id,
            type: "text",
            name: "Binary body",
            content: { bytes: [0, 1, 2, 3] }
          }
        ]) {
          failures.push(await tool.execute("invalid-tool", args));
        }
        yield { type: "text_delta", delta: "Validation complete." };
        yield { type: "text_completed", text: "Validation complete." };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice validate the results" }
    );

    await runs.processRun(started.run!.id);

    expect(failures.map((result) => result.content)).toEqual([
      "Invalid Tool arguments: /type must be equal to one of the allowed values",
      "JSON Artifact content is invalid",
      "Invalid Tool arguments: /content must be string"
    ]);
    expect(failures.map((result) => result.errorKind)).toEqual([
      "validation",
      "validation",
      "validation"
    ]);
    expect(await store.read((current) => current.artifacts)).toEqual([]);
  });

  it("parses names as slugged mentions", () => {
    const state = createFixtureState();
    expect(
      parseMentions("@alice and @bob please review", state.employees)
    ).toEqual({
      all: false,
      employeeIds: [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002"
      ]
    });

    expect(
      parseMentions("@马念媛 请分析", [
        {
          ...state.employees[0],
          name: "马念媛"
        }
      ])
    ).toEqual({
      all: false,
      employeeIds: [state.employees[0].id]
    });

    expect(
      parseMentions("@`马念媛` 请分析", [
        {
          ...state.employees[0],
          name: "马念媛"
        }
      ])
    ).toEqual({
      all: false,
      employeeIds: [state.employees[0].id]
    });
  });

  it("pauses a side-effecting Tool until the user rejects it", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000001";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway()
    );
    const workspace = new WorkspaceService(store, cipher, noopProviderRegistry);

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice publish the update" }
    );
    const processing = runService.processRun(started.run!.id);

    let approval;
    for (let attempt = 0; attempt < 20 && !approval; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      approval = await store.read(
        (current) => current.approvals.find((item) => item.status === "pending") ?? null
      );
    }
    expect(approval).not.toBeNull();
    await workspace.resolveApproval(approval!.id, "rejected");
    const completed = await processing;

    expect(completed.status).toBe("completed");
    const events = await runService.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toContain("approval_requested");
    expect(events.map((event) => event.type)).toContain("approval_resolved");
    expect(events.map((event) => event.type)).toContain("tool_error");
    expect(
      events.find((event) => event.type === "tool_completed")?.payload.isError
    ).toBe(true);
    expect(
      events.find((event) => event.type === "tool_completed")?.payload
    ).toMatchObject({
      result: "The user rejected this Tool call.",
      errorKind: "unauthorized"
    });
  });

  it("executes a side-effecting Tool after approval", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000006";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const calls: ToolExecutionRequest[] = [];
    const toolGateway: ToolGateway = {
      async execute(request) {
        calls.push(request);
        return { content: "Webhook accepted." };
      }
    };
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway(),
      { toolGateway }
    );
    const workspace = new WorkspaceService(store, cipher, noopProviderRegistry);
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Publish update",
        goal: "Publish only after approval.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice publish the update" }
    );
    const processing = runService.processRun(started.run!.id);
    const approval = await waitForPendingApproval(store, started.run!.id);

    expect(
      (await runService.getRunById(started.run!.id))?.status
    ).toBe("waiting_approval");
    expect(approval.taskId).toBe(task.id);
    expect(
      await store.read((current) =>
        current.tasks.find((item) => item.id === task.id)
      )
    ).toMatchObject({ status: "blocked" });
    await workspace.resolveApproval(approval.id, "approved");
    const completed = await processing;

    expect(completed.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool.name).toBe("post_webhook");
    expect(
      await store.read((current) =>
        current.tasks.find((item) => item.id === task.id)
      )
    ).toMatchObject({ status: "in_progress" });
    expect(
      (await runService.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "approval_requested",
        "approval_resolved",
        "tool_completed"
      ])
    );
  });

  it("returns approval cancellation as a structured Tool outcome", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000007";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const calls: ToolExecutionRequest[] = [];
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway(),
      {
        toolGateway: {
          async execute(request) {
            calls.push(request);
            return { content: "should not execute" };
          }
        }
      }
    );
    const workspace = new WorkspaceService(store, cipher, noopProviderRegistry);
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice cancel publishing" }
    );
    const processing = runService.processRun(started.run!.id);
    const approval = await waitForPendingApproval(store, started.run!.id);

    await workspace.resolveApproval(approval.id, "cancelled");
    await processing;

    expect(calls).toEqual([]);
    const events = await runService.listRunEvents(started.run!.id);
    expect(
      events.find((event) => event.type === "tool_completed")?.payload
    ).toMatchObject({ isError: true, errorKind: "cancelled" });
    expect(events.map((event) => event.type)).toContain("tool_cancelled");
  });

  it("expires Approval without executing the Tool", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000008";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const calls: ToolExecutionRequest[] = [];
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway(),
      {
        approvalTimeoutMs: 20,
        toolGateway: {
          async execute(request) {
            calls.push(request);
            return { content: "should not execute" };
          }
        }
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice let publishing expire" }
    );

    const completed = await runService.processRun(started.run!.id);

    expect(completed.status).toBe("completed");
    expect(calls).toEqual([]);
    expect(
      await store.read((current) =>
        current.approvals.find((item) => item.runId === started.run!.id)
      )
    ).toMatchObject({ status: "expired" });
  });

  it("preserves Approval decisions across worker recovery", async () => {
    const state = createFixtureState();
    const employeeId = "20000000-0000-4000-8000-000000000001";
    const runId = "50000000-0000-4000-8000-000000000025";
    const messageId = "message-approval-restart";
    const toolCallId = "tool-call-approval-restart";
    const now = new Date().toISOString();
    state.messages.push({
      id: messageId,
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      authorType: "employee",
      authorId: employeeId,
      content: "",
      runId,
      status: "streaming",
      createdAt: now,
      updatedAt: now
    });
    state.runs.push({
      id: runId,
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      triggerMessageId: "trigger",
      memberSnapshot: [employeeId],
      status: "waiting_approval",
      createdAt: now
    });
    state.approvals.push({
      id: "approval-after-restart",
      workspaceId: state.workspace.id,
      runId,
      messageId,
      employeeId,
      toolCallId,
      toolName: "post_webhook",
      args: {
        url: "https://example.com/hook",
        body: { launch: true }
      },
      status: "rejected",
      createdAt: now,
      resolvedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const store = new MemoryStore(state);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );

    await runService.recoverInterruptedRuns();

    expect((await runService.getRunById(runId))?.status).toBe("interrupted");
    expect(
      await store.read((current) =>
        current.approvals.find((item) => item.id === "approval-after-restart")
      )
    ).toMatchObject({
      status: "rejected",
      toolCallId,
      employeeId
    });
  });

  it("does not resume or complete a Run cancelled while awaiting approval", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000002";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new ToolCallingModelGateway()
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice publish the update" }
    );
    const processing = runService.processRun(started.run!.id);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = await store.read((current) =>
        current.approvals.some(
          (approval) =>
            approval.runId === started.run!.id && approval.status === "pending"
        )
      );
      if (pending) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await runService.cancelRun(started.run!.id);
    await processing;

    expect((await runService.getRunById(started.run!.id))?.status).toBe(
      "cancelled"
    );
    expect(
      (await runService.listMessages(started.message.conversationId)).at(-1)
        ?.status
    ).toBe("cancelled");
    expect(
      await store.read((current) =>
        current.approvals
          .filter((approval) => approval.runId === started.run!.id)
          .every((approval) => approval.status === "cancelled")
      )
    ).toBe(true);
    const cancelledApproval = await store.read((current) =>
      current.approvals.find((approval) => approval.runId === started.run!.id)
    );
    expect(
      (await runService.listRunEvents(started.run!.id)).find(
        (event) => event.type === "approval_resolved"
      )?.payload
    ).toMatchObject({
      messageId: cancelledApproval?.messageId,
      reason: "run_cancelled"
    });
  });

  it("claims a queued Run only once when workers process it concurrently", async () => {
    const store = new MemoryStoreFixture();
    let attempts = 0;
    const engine: ModelGateway = {
      async *run() {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { type: "text_delta", delta: "single" };
        yield { type: "text_completed", text: "single" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice run once" }
    );
    await Promise.all([
      runService.processRun(started.run!.id),
      runService.processRun(started.run!.id)
    ]);

    expect(attempts).toBe(1);
    expect((await runService.getRunById(started.run!.id))?.status).toBe("completed");
  });

  it("marks active Runs as interrupted after a worker restart", async () => {
    const state = createFixtureState();
    state.messages.push({
      id: "streaming-message",
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      authorType: "employee",
      authorId: "20000000-0000-4000-8000-000000000001",
      content: "partial",
      runId: "50000000-0000-4000-8000-000000000001",
      status: "streaming",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.approvals.push({
      id: "pending-approval",
      workspaceId: state.workspace.id,
      runId: "50000000-0000-4000-8000-000000000001",
      messageId: "streaming-message",
      taskId: "task-approval",
      toolName: "post_webhook",
      args: {},
      status: "pending",
      createdAt: state.workspace.createdAt
    });
    state.runs.push({
      id: "50000000-0000-4000-8000-000000000001",
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      triggerMessageId: "trigger",
      memberSnapshot: ["20000000-0000-4000-8000-000000000001"],
      status: "running",
      createdAt: state.workspace.createdAt
    });
    state.providerAttempts.push({
      id: "attempt-interrupted",
      workspaceId: state.workspace.id,
      runId: "50000000-0000-4000-8000-000000000001",
      purpose: "conversation",
      provider: "openai",
      modelId: "test-model",
      targetOrder: 0,
      attempt: 1,
      status: "started",
      usage: { source: "unknown" },
      startedAt: state.workspace.createdAt
    });
    const store = new MemoryStore(state);
    const gateway = new RecordingModelGateway();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );

    await runService.recoverInterruptedRuns();

    expect(
      (await runService.getRunById("50000000-0000-4000-8000-000000000001"))
        ?.status
    ).toBe("interrupted");
    expect(
      await store.read(
        (current) =>
          current.messages.find((message) => message.id === "streaming-message")
            ?.status
      )
    ).toBe("interrupted");
    const events = await runService.listRunEvents(
      "50000000-0000-4000-8000-000000000001"
    );
    expect(events.map((event) => event.type)).toContain(
      "employee_turn_interrupted"
    );
    expect(
      await store.read((current) =>
        current.providerAttempts.find(
          (attempt) => attempt.id === "attempt-interrupted"
        )
      )
    ).toMatchObject({
      status: "ambiguous",
      errorKind: "unknown",
      errorCode: "provider_ambiguous"
    });
    expect(
      events.find(
        (event) =>
          event.type === "provider_attempt_completed" &&
          event.payload.attemptId === "attempt-interrupted"
      )?.payload
    ).toMatchObject({
      status: "ambiguous",
      errorKind: "unknown",
      errorCode: "provider_ambiguous"
    });
    expect(
      events.findIndex(
        (event) =>
          event.type === "provider_attempt_completed" &&
          event.payload.attemptId === "attempt-interrupted"
      )
    ).toBeLessThan(
      events.findIndex((event) => event.type === "run_error")
    );
    expect(
      events.find((event) => event.type === "approval_resolved")?.payload
    ).toMatchObject({
      messageId: "streaming-message",
      taskId: "task-approval"
    });
    expect(
      await store.read(
        (current) =>
          current.approvals.find(
            (approval) => approval.id === "pending-approval"
          )?.status
      )
    ).toBe("cancelled");
    expect(gateway.requests).toHaveLength(0);
  });

  it("cancels an active Model Gateway and marks partial Messages as cancelled", async () => {
    const state = createFixtureState();
    const fallbackProvider = addFallbackProvider(state);
    state.employees[0].fallbackTargets = [
      {
        providerCredentialId: fallbackProvider.id,
        modelId: "fallback-model"
      }
    ];
    const store = new MemoryStore(state);
    let calls = 0;
    const engine: ModelGateway = {
      async *run(request) {
        calls += 1;
        if (request.signal?.aborted) throw new Error("aborted");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          request.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
        });
        yield { type: "text_completed", text: "late" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine,
      { modelContext: fallbackModelContext }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice wait forever" }
    );
    const processing = runService.processRun(started.run!.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await store.read((state) =>
        state.messages.some(
          (message) =>
            message.runId === started.run!.id && message.status === "streaming"
        )
      )
    ).toBe(true);
    await runService.cancelRun(started.run!.id);
    await processing;

    expect((await runService.getRunById(started.run!.id))?.status).toBe("cancelled");
    expect(calls).toBe(1);
    const messages = await runService.listMessages(started.message.conversationId);
    expect(messages.at(-1)?.status).toBe("cancelled");
    const events = await runService.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toContain(
      "employee_turn_cancelled"
    );
    expect(events.map((event) => event.type)).not.toContain(
      "provider_fallback_started"
    );
    expect(
      events.find((event) => event.type === "run_cancelled")?.payload
    ).toMatchObject({
      cooperative: true,
      stopRequested: true
    });
    expect(
      await store.read((state) =>
        state.providerAttempts.find(
          (attempt) => attempt.runId === started.run!.id
        )
      )
    ).toMatchObject({
      status: "cancelled",
      errorKind: "cancelled",
      errorCode: "provider_cancelled"
    });
  });

  it("observes a cancellation written by another service instance", async () => {
    const store = new MemoryStoreFixture();
    let calls = 0;
    const engine: ModelGateway = {
      async *run(request) {
        calls += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          request.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
          if (request.signal?.aborted) {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }
        });
        yield { type: "text_completed", text: "late" };
      }
    };
    const worker = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const web = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const started = await worker.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice wait for cross-process cancel" }
    );
    const processing = worker.processRun(started.run!.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await web.cancelRun(started.run!.id);
    await processing;

    expect((await worker.getRunById(started.run!.id))?.status).toBe("cancelled");
    expect(calls).toBe(1);
    expect(
      (await worker.listMessages(started.message.conversationId)).at(-1)?.status
    ).toBe("cancelled");
  });

  it("resumes an interrupted Run and skips already completed Employees", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway(() => ["resumed"]);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice resume this" }
    );
    await store.update((state) => {
      const run = state.runs.find((item) => item.id === started.run!.id);
      if (run) run.status = "interrupted";
    });

    await runService.resumeRun(started.run!.id);
    await runService.processRun(started.run!.id);

    expect(engine.requests).toHaveLength(1);
    expect((await runService.getRunById(started.run!.id))?.status).toBe("completed");
  });

  it("does not resume after a Tool side effect has started", async () => {
    const store = new MemoryStoreFixture();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice do not replay the Tool" }
    );
    await store.update((state) => {
      const run = state.runs.find((item) => item.id === started.run!.id);
      if (run) run.status = "interrupted";
      state.runEvents.push({
        id: "tool-started-before-restart",
        workspaceId: state.workspace.id,
        runId: started.run!.id,
        sequence:
          Math.max(
            0,
            ...state.runEvents
              .filter((event) => event.runId === started.run!.id)
              .map((event) => event.sequence)
          ) + 1,
        type: "tool_started",
        payload: {
          messageId: started.message.id,
          toolCallId: "unsafe-tool",
          toolName: "post_webhook"
        },
        createdAt: state.workspace.updatedAt
      });
    });

    await expect(runService.resumeRun(started.run!.id)).rejects.toMatchObject({
      code: "run_resume_tool_side_effect"
    });
  });

  it("does not resume after an ambiguous Provider execution", async () => {
    const store = new MemoryStoreFixture();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice do not replay an ambiguous call" }
    );
    await store.update((state) => {
      const run = state.runs.find((item) => item.id === started.run!.id);
      if (run) run.status = "interrupted";
      state.providerAttempts.push({
        id: "ambiguous-before-restart",
        workspaceId: state.workspace.id,
        runId: started.run!.id,
        purpose: "conversation",
        provider: "openai",
        modelId: "test-model",
        targetOrder: 0,
        attempt: 1,
        status: "ambiguous",
        errorKind: "unknown",
        errorCode: "provider_ambiguous",
        usage: { source: "unknown" },
        startedAt: state.workspace.updatedAt,
        completedAt: state.workspace.updatedAt
      });
    });

    await expect(runService.resumeRun(started.run!.id)).rejects.toMatchObject({
      code: "run_resume_ambiguous_execution"
    });
  });

  it("does not resume after visible output was persisted", async () => {
    const store = new MemoryStoreFixture();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice do not replay visible output" }
    );
    await store.update((state) => {
      const run = state.runs.find((item) => item.id === started.run!.id);
      if (run) run.status = "interrupted";
      state.messages.push({
        id: "visible-before-restart",
        workspaceId: state.workspace.id,
        conversationId: started.message.conversationId,
        authorType: "employee",
        authorId: state.employees[0].id,
        content: "already visible",
        runId: started.run!.id,
        status: "interrupted",
        createdAt: state.workspace.updatedAt,
        updatedAt: state.workspace.updatedAt
      });
    });

    await expect(runService.resumeRun(started.run!.id)).rejects.toMatchObject({
      code: "run_resume_visible_output"
    });
  });
});

class MemoryStoreFixture extends MemoryStore {
  constructor() {
    super(createFixtureState());
  }
}

function addFallbackProvider(state: AppState) {
  const cipher = new AesCredentialCipher(TEST_KEY);
  const provider = {
    id: "10000000-0000-4000-8000-000000000002",
    workspaceId: state.workspace.id,
    provider: "anthropic" as const,
    label: "Fallback provider",
    encryptedCredential: cipher.encrypt("fallback-api-key"),
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  state.providers.push(provider);
  return provider;
}

function fallbackModelContext() {
  return {
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    available: true,
    supportsStructuredOutput: true
  };
}

function addApprovalSkill(state: AppState, skillId: string): void {
  state.skills.push({
    id: skillId,
    workspaceId: state.workspace.id,
    name: "Publisher",
    description: "Posts approved updates.",
    instructions: "Publish only after approval.",
    inputs: ["payload"],
    outputs: ["receipt"],
    toolNames: ["post_webhook"],
    builtIn: false,
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  });
  state.employees[0].skillIds.push(skillId);
}

function addFixturePhase(state: AppState) {
  const discussion = createFixtureDiscussion({
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id
  });
  discussion.status = "running";
  const round: DiscussionRound = {
    id: `${discussion.id}-round-2`,
    roundNumber: 2,
    phase: "cross_response",
    status: "pending",
    participantSnapshot: structuredClone(discussion.participants),
    turns: [],
    createdAt: state.workspace.createdAt
  };
  discussion.rounds.push(round);
  state.discussions.push(discussion);
  return { discussion, round };
}

async function waitForPendingApproval(
  store: MemoryStore,
  runId: string
): Promise<Approval> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const approval = await store.read(
      (state) =>
        state.approvals.find(
          (item) => item.runId === runId && item.status === "pending"
        ) ?? null
    );
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Pending Approval was not created");
}

function toolModelGateway(
  toolName: string,
  args: Record<string, unknown>,
  format: (content: string) => string
): ModelGateway {
  return {
    async *run(request) {
      const tool = request.tools.find((item) => item.name === toolName);
      if (!tool) throw new Error(`${toolName} Tool was not available`);
      yield {
        type: "tool_started",
        toolCallId: "test-tool-call",
        toolName,
        args
      };
      const result = await tool.execute(
        "test-tool-call",
        args,
        request.signal
      );
      yield {
        type: "tool_completed",
        toolCallId: "test-tool-call",
        toolName,
        result: result.content,
        isError: Boolean(result.isError),
        errorKind: result.errorKind
      };
      const text = `The Tool returned ${format(result.content)}.`;
      yield { type: "text_delta", delta: text };
      yield { type: "text_completed", text };
    }
  };
}
