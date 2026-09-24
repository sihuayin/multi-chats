import { describe, expect, it } from "vitest";
import {
  conversationEvidenceScope,
  recordMessageCitations,
  resolveConversationCitations
} from "@/server/application/conversation-evidence";
import { citationAliasesIn } from "@/lib/citations";
import { SourceService } from "@/server/application/source-service";
import type {
  SourceTextInput,
  TextExtractor
} from "@/server/application/text-extractor";
import { MemoryStore } from "@/server/store/memory-store";
import { WorkspaceService } from "@/server/application/workspace-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import {
  noopProviderRegistry,
  TEST_KEY
} from "@/server/test-support/fixtures";
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

function historyRetrievalEvent(
  state: AppState,
  runId: string,
  returnedItemIds: string[]
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
      toolName: "search_history",
      isError: false,
      durationMs: 3,
      details: { query: "persistence", returnedItemIds, truncated: false }
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

  it("resolves the origin title at read time and carries the provenance fields", () => {
    const { state, conversationId } = seededState();
    state.conversations.push({
      id: "30000000-0000-4000-8000-000000000005",
      workspaceId: state.workspace.id,
      title: "Payments redesign",
      memberIds: [],
      retrievalExcluded: false,
      createdAt: NOW,
      updatedAt: NOW
    });
    const cited = message(state, {
      id: "message-elsewhere",
      conversationId: "30000000-0000-4000-8000-000000000005",
      content: "The persistence model is append-only."
    });
    historyRetrievalEvent(state, "run-h1", ["message-elsewhere"]);
    // The helper pins the Run to conversations[0]; the retrieved tier is
    // about the Run, not the Conversation the item lives in.
    const reply = message(state, {
      id: "message-reply",
      conversationId,
      content: "History says [message:message-elsewhere].",
      runId: "run-h1"
    });
    recordMessageCitations(state, reply);

    let citations = resolveConversationCitations(state, conversationId);
    expect(citations[0]).toMatchObject({
      alias: "message:message-elsewhere",
      resolved: true,
      originConversationId: "30000000-0000-4000-8000-000000000005",
      originConversationTitle: "Payments redesign",
      excerpt: "The persistence model is append-only.",
      authorName: "Alice",
      itemDate: NOW,
      targetMessageId: "message-elsewhere"
    });

    // Nothing is snapshotted: renaming the origin Conversation moves the
    // title the very next read.
    const origin = state.conversations.find(
      (item) => item.id === "30000000-0000-4000-8000-000000000005"
    )!;
    origin.title = "Renamed redesign";
    citations = resolveConversationCitations(state, conversationId);
    expect(citations[0].originConversationTitle).toBe("Renamed redesign");
    expect(cited.id).toBe("message-elsewhere");
  });

  it("carries no origin fields for a Source citation — a Chunk is not Conversation-owned", () => {
    const { state, conversationId, chunks } = seededState();
    retrievalEvent(state, "run-1", [chunks[0].id]);
    const reply = message(state, {
      id: "message-reply",
      conversationId,
      content: `Docs say [external:${chunks[0].id}].`,
      runId: "run-1"
    });
    recordMessageCitations(state, reply);

    const citations = resolveConversationCitations(state, conversationId);
    expect(citations[0]).toMatchObject({
      resolved: true,
      sourceTitle: "Product docs"
    });
    expect(citations[0].originConversationId).toBeUndefined();
    expect(citations[0].targetMessageId).toBeUndefined();
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


describe("citation invariance", () => {
  async function citedConversation() {
    let fetched = "Original fetched content.";
    const changing: TextExtractor = {
      async extract(input: SourceTextInput) {
        if (input.kind === "url") return fetched;
        return input.content ?? "";
      }
    };
    const store = new MemoryStore(createFixtureState());
    const service = new SourceService(store, changing);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/article"
    });
    await service.ingestPendingSources();
    const originalChunk = (await service.listChunks(created.id))[0];

    const conversationId = await store.read(
      (state) => state.conversations[0].id
    );
    await store.update((state) => {
      state.runs.push({
        id: "run-cite",
        workspaceId: state.workspace.id,
        conversationId,
        triggerMessageId: "trigger",
        memberSnapshot: [],
        status: "completed",
        createdAt: NOW,
        completedAt: NOW
      });
      state.runEvents.push({
        id: "event-cite",
        workspaceId: state.workspace.id,
        runId: "run-cite",
        sequence: 1,
        type: "tool_completed",
        payload: {
          toolName: "search_sources",
          details: { returnedChunkIds: [originalChunk.id] }
        },
        createdAt: NOW
      });
      state.messages.push({
        id: "cite-message",
        workspaceId: state.workspace.id,
        conversationId,
        authorType: "employee",
        authorId: state.employees[0].id,
        content: `The article says so [external:${originalChunk.id}].`,
        runId: "run-cite",
        status: "complete",
        createdAt: NOW,
        updatedAt: NOW
      });
      const cited = state.messages.find(
        (item) => item.id === "cite-message"
      )!;
      recordMessageCitations(state, cited);
    });

    return {
      store,
      service,
      conversationId,
      originalChunk,
      setFetched(next: string) {
        fetched = next;
      }
    };
  }

  it("keeps a citation resolvable after refresh and after tombstone, with the passage unchanged", async () => {
    const { store, service, conversationId, originalChunk, setFetched } =
      await citedConversation();

    const before = await store.read((state) =>
      resolveConversationCitations(state, conversationId)
    );
    expect(before[0]).toMatchObject({
      alias: `external:${originalChunk.id}`,
      resolved: true,
      excerpt: "Original fetched content."
    });

    setFetched("Completely different content after refresh.");
    await service.refreshSource(
      await store.read((state) => state.sources[0].id)
    );

    const afterRefresh = await store.read((state) =>
      resolveConversationCitations(state, conversationId)
    );
    expect(afterRefresh[0]).toMatchObject({
      resolved: true,
      excerpt: "Original fetched content."
    });

    await service.deleteSource(
      await store.read((state) => state.sources[0].id)
    );

    const afterTombstone = await store.read((state) =>
      resolveConversationCitations(state, conversationId)
    );
    expect(afterTombstone[0]).toMatchObject({
      resolved: true,
      excerpt: "Original fetched content."
    });

    // The record of what was cited survives all of it.
    const references = await store.read((state) => state.evidenceReferences);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      kind: "external_source",
      sourceId: originalChunk.id
    });
  });

  it("never changes a chunk's text under a refresh", async () => {
    const { store, service, setFetched } = await citedConversation();
    const sourceId = await store.read((state) => state.sources[0].id);
    const before = structuredClone(
      await store.read((state) => state.chunks)
    );
    expect(before.length).toBeGreaterThan(0);

    setFetched("A new revision with entirely different words.");
    await service.refreshSource(sourceId);

    const after = await store.read((state) => state.chunks);
    for (const old of before) {
      const row = after.find((chunk) => chunk.id === old.id);
      // The live-excerpt argument depends entirely on this: a refresh
      // supersedes by appending, it never rewrites a stored chunk.
      expect(row).toBeDefined();
      expect(row!.content).toBe(old.content);
      expect(row!.contentHash).toBe(old.contentHash);
      expect(row!.superseded).toBe(true);
    }
    const appended = after.filter(
      (chunk) => !before.some((old) => old.id === chunk.id)
    );
    expect(appended.length).toBeGreaterThan(0);
  });
});


describe("History-item citations", () => {
  const OTHER = "30000000-0000-4000-8000-000000000002";

  function stateWithOtherMessage(): {
    state: AppState;
    conversationId: string;
  } {
    const state = createFixtureState();
    const conversationId = state.conversations[0].id;
    state.conversations.push({
      id: OTHER,
      workspaceId: state.workspace.id,
      title: "Payments redesign",
      memberIds: [],
      retrievalExcluded: false,
      createdAt: NOW,
      updatedAt: NOW
    });
    message(state, {
      id: "message-elsewhere",
      conversationId: OTHER,
      content: "The persistence model is append-only."
    });
    return { state, conversationId };
  }

  it("makes a retrieved History item citable in the Run that retrieved it, carrying its origin", () => {
    const { state, conversationId } = stateWithOtherMessage();
    historyRetrievalEvent(state, "run-h1", ["message-elsewhere"]);
    const reply = message(state, {
      id: "message-reply",
      conversationId,
      content: "Our own history says [message:message-elsewhere].",
      runId: "run-h1"
    });

    recordMessageCitations(state, reply);

    expect(state.evidenceReferences).toHaveLength(1);
    const reference = state.evidenceReferences[0];
    expect(reference).toMatchObject({
      id: evidenceReferenceId("message:message-elsewhere"),
      kind: "message",
      sourceId: "message-elsewhere",
      locator: OTHER
    });
    // No excerptHash: Messages were already content-immutable, so the
    // failure mode the hash exists for does not exist here.
    expect(reference.excerptHash).toBeUndefined();

    const citations = resolveConversationCitations(state, conversationId);
    expect(citations).toEqual([
      expect.objectContaining({
        messageId: "message-reply",
        alias: "message:message-elsewhere",
        resolved: true,
        locator: OTHER
      })
    ]);
  });

  it("cites the Conversation's own Tasks and Artifacts natively, with no retrieval", () => {
    const { state, conversationId } = stateWithOtherMessage();
    state.tasks.push({
      id: "task-native",
      workspaceId: state.workspace.id,
      conversationId,
      title: "Decide persistence",
      goal: "Settle it.",
      assigneeIds: [],
      status: "draft",
      history: [],
      createdAt: NOW,
      updatedAt: NOW
    } as AppState["tasks"][number]);
    state.artifacts.push({
      id: "artifact-native",
      workspaceId: state.workspace.id,
      ownerType: "task",
      ownerId: "task-native",
      type: "text",
      name: "Decision notes",
      content: "Append-only.",
      createdAt: NOW,
      updatedAt: NOW
    });
    const reply = message(state, {
      id: "message-reply",
      conversationId,
      content:
        "Per [task:task-native] and [artifact:artifact-native], decided.",
      runId: "run-none"
    });

    recordMessageCitations(state, reply);

    expect(state.evidenceReferences).toHaveLength(2);
    expect(state.evidenceReferences.map((item) => item.kind).sort()).toEqual([
      "artifact",
      "task"
    ]);
    for (const reference of state.evidenceReferences) {
      expect(reference.locator).toBe(conversationId);
      expect(reference.excerptHash).toBeUndefined();
    }
  });

  it("keeps an unretrieved, uncited item of another Conversation out", () => {
    const { state, conversationId } = stateWithOtherMessage();
    const reply = message(state, {
      id: "message-reply",
      conversationId,
      content: "Reaching for [message:message-elsewhere] directly.",
      runId: "run-none"
    });

    recordMessageCitations(state, reply);

    expect(state.evidenceReferences).toHaveLength(0);
    const citations = resolveConversationCitations(state, conversationId);
    expect(citations[0].resolved).toBe(false);
    // Not in the citable set at all: plain unresolved, NOT dangling — the
    // two failure modes render differently (#194).
    expect(citations[0].dangling).toBeUndefined();
  });

  it("keeps a citation whose target died with its Conversation as a dangling chip", async () => {
    const { state, conversationId } = stateWithOtherMessage();
    historyRetrievalEvent(state, "run-h1", ["message-elsewhere"]);
    const reply = message(state, {
      id: "message-reply",
      conversationId,
      content: "History says [message:message-elsewhere].",
      runId: "run-h1"
    });
    recordMessageCitations(state, reply);
    expect(
      resolveConversationCitations(state, conversationId)[0].resolved
    ).toBe(true);

    // The deletion that produces the first dangling reference this repo can
    // have — the same code path #201 fixed.
    const store = new MemoryStore(state);
    await new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    ).deleteConversation(OTHER);

    const after = await store.read((current) => ({
      citations: resolveConversationCitations(current, conversationId),
      references: current.evidenceReferences
    }));
    // The row went with its target...
    expect(after.references).toHaveLength(0);
    // ...and the citation stays a chip, with nothing left to name: no
    // origin, no passage, no door, no message to mark.
    expect(after.citations[0]).toMatchObject({
      alias: "message:message-elsewhere",
      resolved: false,
      dangling: true
    });
    expect(after.citations[0].originConversationTitle).toBeUndefined();
    expect(after.citations[0].excerpt).toBeUndefined();
    expect(after.citations[0].targetMessageId).toBeUndefined();
  });

  it("keeps a cited History item re-citable in a later Run without re-retrieval, recorded once", () => {
    const { state, conversationId } = stateWithOtherMessage();
    historyRetrievalEvent(state, "run-h1", ["message-elsewhere"]);
    const first = message(state, {
      id: "message-reply",
      conversationId,
      content: "History says [message:message-elsewhere].",
      runId: "run-h1"
    });
    recordMessageCitations(state, first);

    const followUp = message(state, {
      id: "message-followup",
      conversationId,
      content: "As established [message:message-elsewhere].",
      runId: "run-h2"
    });
    recordMessageCitations(state, followUp);

    expect(state.evidenceReferences).toHaveLength(1);
    const citations = resolveConversationCitations(state, conversationId);
    expect(citations).toHaveLength(2);
    expect(citations.every((citation) => citation.resolved)).toBe(true);
  });

  it("applies no existence filter: the citable set is a rule, not a snapshot", () => {
    const { state, conversationId } = stateWithOtherMessage();
    // The Run "retrieved" an id whose row does not exist (a Conversation
    // deleted elsewhere). The set still carries it — membership does not
    // depend on the life or death of another Conversation — while
    // resolution of a target with no row is #211's dangling case.
    historyRetrievalEvent(state, "run-h1", ["message-ghost"]);
    const reply = message(state, {
      id: "message-reply",
      conversationId,
      content: "Citing [message:message-ghost].",
      runId: "run-h1"
    });

    const scope = conversationEvidenceScope(
      state,
      state.conversations[0],
      reply
    );
    expect(scope.citableIds?.has("message-ghost")).toBe(true);

    recordMessageCitations(state, reply);
    expect(state.evidenceReferences).toHaveLength(0);
    const citations = resolveConversationCitations(state, conversationId);
    expect(citations[0].resolved).toBe(false);
  });
});
