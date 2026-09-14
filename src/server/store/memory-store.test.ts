import { describe, expect, it } from "vitest";
import { createFixtureDiscussion, createFixtureState } from "@/server/test-support/fixtures";
import { MemoryStore } from "@/server/store/memory-store";

describe("MemoryStore runtime contracts", () => {
  it("migrates v2 state when the store is created", async () => {
    const legacy = createFixtureState() as unknown as Record<string, unknown>;
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

    const store = new MemoryStore(legacy as never);

    expect(await store.read((state) => state.schemaVersion)).toBe(4);
    expect(await store.read((state) => state.providerAttempts)).toEqual([]);
  });

  it("rejects runtime records that contain credentials before writing", async () => {
    const state = createFixtureState();
    const store = new MemoryStore(state);

    await expect(
      store.update((current) => {
        current.providerAttempts.push({
          id: "attempt-credential",
          workspaceId: current.workspace.id,
          purpose: "conversation",
          provider: "openai",
          modelId: "test-model",
          targetOrder: 0,
          attempt: 1,
          status: "succeeded",
          usage: { source: "unknown" },
          credential: "must-not-persist",
          startedAt: current.workspace.createdAt
        } as never);
      })
    ).rejects.toThrow("Workspace providerAttempts are invalid");
    expect(await store.read((current) => current.providerAttempts)).toEqual([]);
  });

  it("round-trips persisted runtime records without credentials", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    const provider = state.providers[0];
    const employee = state.employees[0];
    const sourceTurn = discussion.rounds[0].turns[0];
    state.discussions.push(discussion);
    state.messages.push({
      id: sourceTurn.messageId!,
      workspaceId: state.workspace.id,
      conversationId: discussion.conversationId,
      discussionId: discussion.id,
      discussionTurnId: sourceTurn.id,
      authorType: "employee",
      authorId: sourceTurn.employeeId,
      content: "Source Turn",
      status: "complete",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    employee.fallbackTargets = [
      {
        providerCredentialId: provider.id,
        modelId: "fallback-model"
      }
    ];
    state.providerAttempts.push({
      id: "attempt-memory",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      purpose: "discussion_turn",
      provider: provider.provider,
      modelId: employee.modelId,
      targetOrder: 0,
      attempt: 1,
      status: "succeeded",
      usage: { inputTokens: 10, outputTokens: 5, source: "provider" },
      startedAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    state.evidenceReferences.push({
      id: "evidence-memory",
      workspaceId: state.workspace.id,
      kind: "turn",
      sourceId: discussion.rounds[0].turns[0].id,
      createdAt: state.workspace.createdAt
    });
    state.discussionCompressions.push({
      id: "compression-memory",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      status: "completed",
      sourceRoundIds: [discussion.rounds[0].id],
      sourceTurnIds: [discussion.rounds[0].turns[0].id],
      evidenceIds: ["evidence-memory"],
      content: "Compressed history",
      unresolvedQuestions: [],
      minorityPositions: [],
      schemaVersion: 1,
      promptProfileVersion: "discussion-prompts.v2",
      compressionProfileVersion: "discussion-compression.v1",
      contentHash: "hash-memory",
      sourceSpanHash: "source-span-memory",
      strategy: "extractive",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.discussionInterventions.push({
      id: "intervention-memory",
      workspaceId: state.workspace.id,
      discussionId: discussion.id,
      kind: "constraint",
      content: "Keep the migration reversible.",
      status: "pending",
      createdBy: "user",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.discussionContextRevisions.push({
      id: "context-memory",
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
      outputReserveTokens: 40,
      countSource: "estimated",
      contextHash: "context-hash",
      roundIds: [discussion.rounds[0].id],
      turnIds: [sourceTurn.id],
      messageIds: [discussion.rounds[0].turns[0].messageId!],
      compressionIds: ["compression-memory"],
      createdAt: state.workspace.createdAt
    });
    state.modelPricing.push({
      id: "pricing-memory",
      workspaceId: state.workspace.id,
      provider: provider.provider,
      modelId: employee.modelId,
      currency: "USD",
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 2_000_000,
      effectiveAt: state.workspace.createdAt,
      source: "test",
      version: "1",
      createdAt: state.workspace.createdAt
    });

    const store = new MemoryStore(state);

    expect(await store.read((current) => current.providerAttempts)).toEqual(
      state.providerAttempts
    );
    expect(await store.read((current) => current.evidenceReferences)).toEqual(
      state.evidenceReferences
    );
    expect(
      await store.read((current) => current.discussionCompressions)
    ).toEqual(state.discussionCompressions);
    expect(
      await store.read((current) => current.discussionInterventions)
    ).toEqual(state.discussionInterventions);
    expect(
      await store.read((current) => current.discussionContextRevisions)
    ).toEqual(state.discussionContextRevisions);
    expect(await store.read((current) => current.modelPricing)).toEqual(
      state.modelPricing
    );
    expect(
      await store.read((current) => current.employees[0].fallbackTargets)
    ).toEqual(employee.fallbackTargets);
  });
});
