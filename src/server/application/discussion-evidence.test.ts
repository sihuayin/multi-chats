import { describe, expect, it } from "vitest";
import {
  DiscussionEvidenceError,
  availableEvidence,
  evidenceAlias,
  repairDiscussionBriefEvidence,
  repairDiscussionTurnEvidence,
  resolveBriefFactEvidence,
  resolveEvidence,
  validateDiscussionTurnEvidence
} from "@/server/application/discussion-evidence";
import type { EvidenceScope } from "@/server/application/discussion-evidence";
import {
  createFixtureBrief,
  createFixtureDiscussion,
  createFixtureState
} from "@/server/test-support/fixtures";
import type {
  DiscussionTurnPayload,
  Source
} from "@/server/domain/types";
import type { DiscussionBriefV2 } from "@/server/application/discussion-brief";
import { chunkSource } from "@/server/application/source-chunking";

function fixture() {
  const state = createFixtureState();
  const discussion = createFixtureDiscussion({
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id
  });
  state.discussions.push(discussion);
  const turn = discussion.rounds[0].turns[0];
  const message = {
    id: "message-evidence",
    workspaceId: state.workspace.id,
    conversationId: discussion.conversationId,
    discussionId: discussion.id,
    discussionTurnId: turn.id,
    authorType: "employee" as const,
    authorId: turn.employeeId,
    content: "Evidence message",
    status: "complete" as const,
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  const task = {
    id: "task-evidence",
    workspaceId: state.workspace.id,
    conversationId: discussion.conversationId,
    title: "Evidence task",
    goal: "Preserve evidence.",
    assigneeIds: [turn.employeeId],
    status: "draft" as const,
    history: [],
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  const artifact = {
    id: "artifact-evidence",
    workspaceId: state.workspace.id,
    ownerType: "task" as const,
    ownerId: task.id,
    type: "text" as const,
    name: "Evidence artifact",
    content: "Evidence",
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  const run = {
    id: "run-evidence",
    workspaceId: state.workspace.id,
    conversationId: discussion.conversationId,
    discussionId: discussion.id,
    triggerMessageId: message.id,
    memberSnapshot: [turn.employeeId],
    status: "completed" as const,
    createdAt: state.workspace.createdAt,
    completedAt: state.workspace.updatedAt
  };
  const toolEvent = {
    id: "event-tool-evidence",
    workspaceId: state.workspace.id,
    runId: run.id,
    sequence: 1,
    type: "tool_completed" as const,
    payload: { toolName: "fetch_url" },
    createdAt: state.workspace.createdAt
  };
  state.messages.push(message);
  state.tasks.push(task);
  state.artifacts.push(artifact);
  state.runs.push(run);
  state.runEvents.push(toolEvent);
  return { state, discussion, turn, message, task, artifact, toolEvent };
}

function payload(evidenceIds: string[]): DiscussionTurnPayload {
  return {
    summary: "Evidence-backed response",
    claims: [
      {
        statement: "A supported fact.",
        kind: "fact",
        evidenceIds,
        confidence: "high"
      }
    ],
    assumptions: [],
    risks: [],
    openQuestions: []
  };
}

function attachSource(
  state: ReturnType<typeof createFixtureState>,
  discussion: ReturnType<typeof createFixtureDiscussion>
): { source: Source; chunkId: string } {
  const source: Source = {
    id: "source-attached",
    workspaceId: state.workspace.id,
    title: "Attached source",
    kind: "file",
    location: "notes.md",
    status: "ready",
    chunkCount: 2,
    contentHash: "source-hash",
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  state.sources.push(source);
  const chunks = chunkSource({
    sourceId: source.id,
    workspaceId: state.workspace.id,
    text: "First chunk.\n\nSecond chunk.",
    now: state.workspace.createdAt
  });
  state.chunks.push(...chunks);
  discussion.sourceIds = [source.id];
  return { source, chunkId: chunks[0].id };
}

describe("Discussion evidence", () => {
  it("resolves every supported evidence kind", () => {
    const value = fixture();
    const aliases = [
      evidenceAlias("turn", value.turn.id),
      evidenceAlias("message", value.message.id),
      evidenceAlias("task", value.task.id),
      evidenceAlias("artifact", value.artifact.id),
      evidenceAlias("tool_result", value.toolEvent.id),
      "external:https://example.com/source"
    ];

    const result = validateDiscussionTurnEvidence(
      value.state,
      value.discussion,
      payload(aliases)
    );

    expect(result.references.map((reference) => reference.kind)).toEqual([
      "turn",
      "message",
      "task",
      "artifact",
      "tool_result",
      "external_source"
    ]);
    expect(result.coverage).toEqual({
      claimCount: 1,
      claimsWithEvidence: 1
    });
  });

  it("rejects fact claims without evidence", () => {
    const value = fixture();
    expect(() =>
      validateDiscussionTurnEvidence(
        value.state,
        value.discussion,
        payload([])
      )
    ).toThrow(DiscussionEvidenceError);
  });

  it("keeps inference claims explicitly labelled without evidence", () => {
    const value = fixture();
    const result = validateDiscussionTurnEvidence(
      value.state,
      value.discussion,
      {
        ...payload([]),
        claims: [
          {
            statement: "A possible explanation.",
            kind: "inference",
            confidence: "medium"
          }
        ]
      }
    );

    expect(result.payload.claims[0]).toMatchObject({
      kind: "inference"
    });
    expect(result.payload.claims[0].evidenceIds).toBeUndefined();
  });

  it("rejects references outside the Discussion scope", () => {
    const value = fixture();
    expect(() =>
      validateDiscussionTurnEvidence(
        value.state,
        value.discussion,
        payload(["message:outside"])
      )
    ).toThrow("outside the Discussion");
  });

  it("repairs invalid Turn evidence by removing references and downgrading facts", () => {
    const value = fixture();
    const repaired = repairDiscussionTurnEvidence(
      value.state,
      value.discussion,
      payload(["message:outside"])
    );

    expect(repaired.payload.claims[0]).toMatchObject({
      kind: "inference",
      evidenceIds: []
    });
    expect(repaired).toMatchObject({
      downgradedClaims: 1,
      removedEvidenceIds: 1
    });
  });

  it("repairs an unsupported Brief fact from grounded Position claims", () => {
    const value = fixture();
    value.turn.payload!.claims[0] = {
      ...value.turn.payload!.claims[0],
      kind: "fact",
      evidenceIds: ["external:https://example.com/supported"]
    };
    const fixtureBrief = createFixtureBrief(value.discussion.id);
    if (fixtureBrief.schemaVersion !== 2) {
      throw new Error("Fixture Brief must use schema v2");
    }
    const brief: DiscussionBriefV2 = {
      ...fixtureBrief,
      facts: [
        {
          statement: "Unsupported Brief fact.",
          kind: "fact" as const,
          evidenceIds: ["message:outside"]
        }
      ]
    };

    const repaired = repairDiscussionBriefEvidence(
      value.state,
      value.discussion,
      brief
    );

    expect(repaired).toMatchObject({
      removedFacts: 1,
      restoredFacts: 1
    });
    expect(repaired.brief.facts).toEqual([
      {
        statement: "Use the existing state document.",
        kind: "fact",
        evidenceIds: ["external:https://example.com/supported"]
      }
    ]);
  });

  it("resolves an attached Source chunk as an external_source reference", () => {
    const value = fixture();
    const { chunkId } = attachSource(value.state, value.discussion);

    const result = validateDiscussionTurnEvidence(
      value.state,
      value.discussion,
      payload([`external:${chunkId}`])
    );

    expect(result.references[0]).toMatchObject({
      kind: "external_source",
      sourceId: chunkId,
      locator: "notes.md"
    });
  });

  it("rejects a chunk whose Source is not attached to the Discussion", () => {
    const value = fixture();
    const { chunkId } = attachSource(value.state, value.discussion);
    value.discussion.sourceIds = [];

    expect(() =>
      validateDiscussionTurnEvidence(
        value.state,
        value.discussion,
        payload([`external:${chunkId}`])
      )
    ).toThrow("outside the Discussion");
  });

  it("resolves an attached Source at the source level", () => {
    const value = fixture();
    const { source } = attachSource(value.state, value.discussion);

    const result = validateDiscussionTurnEvidence(
      value.state,
      value.discussion,
      payload([`external:${source.id}`])
    );

    expect(result.references[0]).toMatchObject({
      kind: "external_source",
      sourceId: source.id,
      locator: "notes.md"
    });
  });

  it("lists attached Source chunks in availableEvidence", () => {
    const value = fixture();
    const { chunkId } = attachSource(value.state, value.discussion);

    const evidence = availableEvidence(value.state, value.discussion);

    expect(
      evidence.some(
        (item) =>
          item.id === `external:${chunkId}` &&
          item.kind === "external_source"
      )
    ).toBe(true);
  });
});

describe("resolveBriefFactEvidence", () => {
  it("resolves a chunk citation to excerpt, source title, and hash", () => {
    const value = fixture();
    const { source, chunkId } = attachSource(
      value.state,
      value.discussion
    );

    const result = resolveBriefFactEvidence(value.state, value.discussion, {
      facts: [{ statement: "A fact.", evidenceIds: [`external:${chunkId}`] }]
    });

    expect(result).toHaveLength(1);
    expect(result[0].resolved).toHaveLength(1);
    expect(result[0].unresolvedIds).toEqual([]);
    const resolved = result[0].resolved[0];
    expect(resolved.chunkId).toBe(chunkId);
    expect(resolved.sourceTitle).toBe(source.title);
    expect(resolved.excerpt).toBe("First chunk.");
    expect(resolved.excerptHash).toBe(
      value.state.chunks.find((chunk) => chunk.id === chunkId)?.contentHash
    );
  });

  it("surfaces unresolved evidence ids instead of dropping them", () => {
    const value = fixture();
    const { chunkId } = attachSource(value.state, value.discussion);

    const result = resolveBriefFactEvidence(value.state, value.discussion, {
      facts: [
        {
          statement: "A fact.",
          evidenceIds: [`external:${chunkId}`, "external:missing-chunk"]
        }
      ]
    });

    expect(result[0].resolved).toHaveLength(1);
    expect(result[0].unresolvedIds).toEqual(["external:missing-chunk"]);
  });
});


describe("evidence scope", () => {
  function scopeFor(overrides: Partial<EvidenceScope> = {}): EvidenceScope {
    return {
      conversationId: "30000000-0000-4000-8000-000000000001",
      turns: [],
      runIds: [],
      citableSourceIds: new Set<string>(),
      ...overrides
    };
  }

  it("resolves a chunk the scope declares citable even when no Discussion attaches it", () => {
    const { state, discussion } = fixture();
    const { source, chunkId } = attachSource(state, discussion);
    // Detach: the Discussion no longer attaches the Source, so the only
    // thing that can make the chunk citable is the scope's data.
    discussion.sourceIds = [];
    const scope = scopeFor({
      citableSourceIds: new Set([source.id])
    });

    const { reference, label } = resolveEvidence(
      state,
      scope,
      `external:${chunkId}`,
      new Date().toISOString()
    );

    expect(reference.kind).toBe("external_source");
    expect(reference.sourceId).toBe(chunkId);
    expect(reference.locator).toBe("notes.md");
    expect(label).toBe("First chunk.");
  });

  it("rejects a chunk whose source the scope omits", () => {
    const { state, discussion } = fixture();
    const { chunkId } = attachSource(state, discussion);
    const scope = scopeFor();

    expect(() =>
      resolveEvidence(
        state,
        scope,
        `external:${chunkId}`,
        new Date().toISOString()
      )
    ).toThrow(DiscussionEvidenceError);
  });

  it("judges tool_result aliases by scope.runIds alone", () => {
    const { state, toolEvent } = fixture();
    const now = new Date().toISOString();

    expect(() =>
      resolveEvidence(
        state,
        scopeFor(),
        `tool_result:${toolEvent.id}`,
        now
      )
    ).toThrow(DiscussionEvidenceError);

    const { reference, label } = resolveEvidence(
      state,
      scopeFor({ runIds: ["run-evidence"] }),
      `tool_result:${toolEvent.id}`,
      now
    );
    expect(reference.kind).toBe("tool_result");
    expect(label).toBe("fetch_url");
  });

  it("resolves turns supplied as data", () => {
    const { state } = fixture();
    const scope = scopeFor({
      turns: [{ id: "turn-data", content: "Data turn content" }]
    });

    const { reference, label } = resolveEvidence(
      state,
      scope,
      "turn:turn-data",
      new Date().toISOString()
    );

    expect(reference.kind).toBe("turn");
    expect(label).toBe("Data turn content");
  });
});
