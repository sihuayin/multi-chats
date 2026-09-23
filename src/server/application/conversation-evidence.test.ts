import { describe, expect, it } from "vitest";
import {
  conversationEvidenceScope,
  recordMessageCitations,
  resolveConversationCitations
} from "@/server/application/conversation-evidence";
import { citationAliasesIn } from "@/lib/citations";
import { evidenceReferenceId } from "@/server/application/discussion-evidence";
import { chunkSource } from "@/server/application/source-chunking";
import { createFixtureState } from "@/server/test-support/fixtures";
import type { AppState, Chunk, Message, Source } from "@/server/domain/types";

const NOW = "2026-01-01T00:00:00.000Z";

function seededState(): {
  state: AppState;
  conversationId: string;
  otherConversationId: string;
  chunks: Chunk[];
} {
  const state = createFixtureState();
  const conversationId = state.conversations[0].id;
  const otherConversationId = "30000000-0000-4000-8000-000000000009";
  state.conversations.push({
    id: otherConversationId,
    workspaceId: state.workspace.id,
    title: "Other conversation",
    memberIds: [],
    retrievalExcluded: false,
    createdAt: NOW,
    updatedAt: NOW
  });
  const source: Source = {
    id: "source-docs",
    workspaceId: state.workspace.id,
    title: "Product docs",
    kind: "file",
    location: "docs/persistence.md",
    status: "ready",
    chunkCount: 2,
    createdAt: NOW,
    updatedAt: NOW
  };
  const chunks = chunkSource({
    sourceId: source.id,
    workspaceId: state.workspace.id,
    text: `${"SQLite durability is our persistence story. ".repeat(8)}\n\nUnrelated release calendar notes.`,
    now: NOW
  });
  state.sources.push(source);
  state.chunks.push(...chunks);
  return { state, conversationId, otherConversationId, chunks };
}

function message(
  state: AppState,
  input: {
    id: string;
    conversationId: string;
    content: string;
    runId?: string;
    discussionId?: string;
    status?: Message["status"];
  }
): Message {
  const message: Message = {
    id: input.id,
    workspaceId: state.workspace.id,
    conversationId: input.conversationId,
    authorType: "employee",
    authorId: state.employees[0].id,
    content: input.content,
    status: input.status ?? "complete",
    createdAt: NOW,
    updatedAt: NOW,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.discussionId ? { discussionId: input.discussionId } : {})
  };
  state.messages.push(message);
  return message;
}

function retrievalEvent(
  state: AppState,
  runId: string,
  returnedChunkIds: string[]
): void {
  state.runs.push({
    id: runId,
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id,
    triggerMessageId: "trigger",
    memberSnapshot: [],
    status: "completed",
    createdAt: NOW,
    completedAt: NOW
  });
  state.runEvents.push({
    id: `event-${runId}`,
    workspaceId: state.workspace.id,
    runId,
    sequence: 1,
    type: "tool_completed",
    payload: {
      toolName: "search_sources",
      isError: false,
      durationMs: 5,
      details: {
        query: "durability",
        limit: 5,
        returnedChunkIds,
        sourceTitles: ["Product docs"],
        truncated: false
      }
    },
    createdAt: NOW
  });
}

describe("citationAliasesIn", () => {
  it("finds bracketed aliases in prose, deduped in order", () => {
    expect(
      citationAliasesIn(
        "A [external:chunk-a] and [external:chunk-b], again [external:chunk-a], not [External:x] nor [ external:y ]."
      )
    ).toEqual(["external:chunk-a", "external:chunk-b"]);
  });
});

describe("Conversation citations", () => {
  it("resolves a chunk retrieved during the Run, and records it once", () => {
    const { state, conversationId, chunks } = seededState();
    retrievalEvent(state, "run-1", [chunks[0].id]);
    const reply = message(state, {
      id: "message-1",
      conversationId,
      content: `Our docs say so [external:${chunks[0].id}].`,
      runId: "run-1"
    });

    recordMessageCitations(state, reply);

    const references = state.evidenceReferences;
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      id: evidenceReferenceId(`external:${chunks[0].id}`),
      kind: "external_source",
      sourceId: chunks[0].id
    });

    const citations = resolveConversationCitations(state, conversationId);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      messageId: "message-1",
      alias: `external:${chunks[0].id}`,
      resolved: true,
      chunkId: chunks[0].id,
      sourceTitle: "Product docs"
    });
    // The excerpt is the chunk's current, complete text — not the resolver's
    // 160-char label.
    expect(citations[0].excerpt).toBe(chunks[0].content);
    expect(chunks[0].content.length).toBeGreaterThan(160);
  });

  it("keeps an earlier turn's citation resolvable in a later Run without re-retrieval", () => {
    const { state, conversationId, chunks } = seededState();
    retrievalEvent(state, "run-1", [chunks[0].id]);
    const first = message(state, {
      id: "message-1",
      conversationId,
      content: `Found it [external:${chunks[0].id}].`,
      runId: "run-1"
    });
    recordMessageCitations(state, first);

    // A later Run retrieves nothing and cites the same chunk.
    const followUp = message(state, {
      id: "message-2",
      conversationId,
      content: `As established [external:${chunks[0].id}].`,
      runId: "run-2"
    });
    recordMessageCitations(state, followUp);

    // Deduped: the same chunk cited twice is one record, not two.
    expect(state.evidenceReferences).toHaveLength(1);

    const citations = resolveConversationCitations(state, conversationId);
    expect(citations).toHaveLength(2);
    expect(citations.every((citation) => citation.resolved)).toBe(true);
  });

  it("does not make a retrieved-but-never-cited chunk citable in a later Run", () => {
    const { state, conversationId, chunks } = seededState();
    // Run 1 retrieved both chunks but the reply cited only the first.
    retrievalEvent(state, "run-1", [chunks[0].id, chunks[1].id]);
    const first = message(state, {
      id: "message-1",
      conversationId,
      content: `Found it [external:${chunks[0].id}].`,
      runId: "run-1"
    });
    recordMessageCitations(state, first);

    const followUp = message(state, {
      id: "message-2",
      conversationId,
      content: `Reaching for [external:${chunks[1].id}] now.`,
      runId: "run-2"
    });
    recordMessageCitations(state, followUp);

    expect(state.evidenceReferences).toHaveLength(1);
    const citations = resolveConversationCitations(state, conversationId);
    const later = citations.find(
      (citation) => citation.messageId === "message-2"
    );
    expect(later?.resolved).toBe(false);
  });

  it("never resolves a chunk belonging to another Conversation", () => {
    const { state, conversationId, otherConversationId, chunks } =
      seededState();
    // The chunk was retrieved by a Run of the OTHER conversation.
    state.runs.push({
      id: "run-other",
      workspaceId: state.workspace.id,
      conversationId: otherConversationId,
      triggerMessageId: "trigger-other",
      memberSnapshot: [],
      status: "completed",
      createdAt: NOW,
      completedAt: NOW
    });
    state.runEvents.push({
      id: "event-run-other",
      workspaceId: state.workspace.id,
      runId: "run-other",
      sequence: 1,
      type: "tool_completed",
      payload: {
        toolName: "search_sources",
        details: { returnedChunkIds: [chunks[0].id] }
      },
      createdAt: NOW
    });
    // ...and cited there.
    message(state, {
      id: "message-other",
      conversationId: otherConversationId,
      content: `Other room [external:${chunks[0].id}].`,
      runId: "run-other"
    });

    const here = message(state, {
      id: "message-here",
      conversationId,
      content: `Reaching across [external:${chunks[0].id}].`,
      runId: "run-3"
    });
    recordMessageCitations(state, here);

    expect(state.evidenceReferences).toHaveLength(0);
    const citations = resolveConversationCitations(state, conversationId);
    expect(citations).toHaveLength(1);
    expect(citations[0].resolved).toBe(false);
  });

  it("leaves an unresolvable alias soft: no record, resolved false, nothing thrown", () => {
    const { state, conversationId } = seededState();
    const reply = message(state, {
      id: "message-1",
      conversationId,
      content: "A hallucinated [external:chunk-nope] stays as written.",
      runId: "run-1"
    });

    expect(() => recordMessageCitations(state, reply)).not.toThrow();
    expect(state.evidenceReferences).toHaveLength(0);

    const citations = resolveConversationCitations(state, conversationId);
    expect(citations).toEqual([
      {
        messageId: "message-1",
        alias: "external:chunk-nope",
        resolved: false
      }
    ]);
  });

  it("ignores unpublished messages in the already-cited scan", () => {
    const { state, conversationId, chunks } = seededState();
    // An interrupted message cited the chunk; it never published, so a later
    // message may not lean on it.
    message(state, {
      id: "message-broken",
      conversationId,
      content: `Broken [external:${chunks[0].id}].`,
      runId: "run-0",
      status: "interrupted"
    });
    const reply = message(state, {
      id: "message-1",
      conversationId,
      content: `Leaning [external:${chunks[0].id}].`,
      runId: "run-1"
    });
    recordMessageCitations(state, reply);

    expect(state.evidenceReferences).toHaveLength(0);
    const citations = resolveConversationCitations(state, conversationId);
    expect(citations.some((citation) => citation.resolved)).toBe(false);
  });

  it("leaves Discussion messages to the Discussion's own evidence surface", () => {
    const { state, conversationId, chunks } = seededState();
    retrievalEvent(state, "run-d", [chunks[0].id]);
    const discussionMessage = message(state, {
      id: "message-discussion",
      conversationId,
      content: `A Turn summary citing [external:${chunks[0].id}].`,
      runId: "run-d",
      discussionId: "discussion-1"
    });
    recordMessageCitations(state, discussionMessage);
    expect(state.evidenceReferences).toHaveLength(0);
    expect(resolveConversationCitations(state, conversationId)).toEqual([]);
  });

  it("builds the scope as data: retrieved ∪ already-cited, nothing else", () => {
    const { state, conversationId, chunks } = seededState();
    retrievalEvent(state, "run-1", [chunks[0].id]);
    message(state, {
      id: "message-1",
      conversationId,
      content: `Cited earlier [external:${chunks[1].id}].`,
      runId: "run-0"
    });
    const current = message(state, {
      id: "message-2",
      conversationId,
      content: "Following up.",
      runId: "run-1"
    });

    const scope = conversationEvidenceScope(
      state,
      state.conversations[0],
      current
    );
    expect(scope.conversationId).toBe(conversationId);
    expect(scope.runIds).toEqual(["run-1"]);
    expect(scope.turns).toEqual([]);
    expect(scope.citableSourceIds.size).toBe(0);
    expect([...(scope.citableChunkIds ?? [])].sort()).toEqual(
      [chunks[0].id, chunks[1].id].sort()
    );
  });
});
