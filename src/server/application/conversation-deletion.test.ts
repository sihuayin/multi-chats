import { describe, expect, it } from "vitest";
import { WorkspaceService } from "@/server/application/workspace-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureDiscussion,
  createFixtureState,
  noopProviderRegistry,
  TEST_KEY
} from "@/server/test-support/fixtures";
import type { AppState, EvidenceReference } from "@/server/domain/types";

const NOW = "2026-01-01T00:00:00.000Z";
const DELETED = "30000000-0000-4000-8000-000000000001";
const SURVIVOR = "30000000-0000-4000-8000-000000000002";

function service(store: MemoryStore): WorkspaceService {
  return new WorkspaceService(
    store,
    new AesCredentialCipher(TEST_KEY),
    noopProviderRegistry
  );
}

function reference(
  state: AppState,
  input: {
    id: string;
    kind: EvidenceReference["kind"];
    sourceId: string;
    locator?: string;
  }
): EvidenceReference {
  const row: EvidenceReference = {
    id: input.id,
    workspaceId: state.workspace.id,
    kind: input.kind,
    sourceId: input.sourceId,
    ...(input.locator !== undefined ? { locator: input.locator } : {}),
    createdAt: NOW
  };
  state.evidenceReferences.push(row);
  return row;
}

function seededState(): AppState {
  const state = createFixtureState();
  state.conversations.push({
    id: SURVIVOR,
    workspaceId: state.workspace.id,
    title: "Survivor",
    memberIds: [],
    retrievalExcluded: false,
    createdAt: NOW,
    updatedAt: NOW
  });
  return state;
}

describe("Conversation deletion and the evidence ledger", () => {
  it("deletes a Conversation whose own citations point at what it removes", async () => {
    // The shipped defect: this threw "Workspace evidenceReferences are
    // invalid" and the Conversation survived.
    const state = seededState();
    state.messages.push({
      id: "message-c1",
      workspaceId: state.workspace.id,
      conversationId: DELETED,
      authorType: "employee",
      authorId: state.employees[0].id,
      content: "Cited by its own Conversation.",
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    });
    reference(state, {
      id: "reference-native",
      kind: "message",
      sourceId: "message-c1"
    });
    const store = new MemoryStore(state);

    await service(store).deleteConversation(DELETED);

    const after = await store.read((current) => ({
      conversation: current.conversations.find((item) => item.id === DELETED),
      messages: current.messages.filter(
        (item) => item.conversationId === DELETED
      ),
      references: current.evidenceReferences
    }));
    expect(after.conversation).toBeUndefined();
    expect(after.messages).toHaveLength(0);
    expect(after.references).toHaveLength(0);
  });

  it("prunes every kind the cascade can orphan, enumerable from its own id sets", async () => {
    const state = seededState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: DELETED
    });
    state.discussions.push(discussion);
    const turnId = discussion.rounds[0].turns[0].id;
    state.tasks.push({
      id: "task-c1",
      workspaceId: state.workspace.id,
      conversationId: DELETED,
      title: "Task in the deleted Conversation",
      goal: "Goal.",
      assigneeIds: [],
      status: "draft",
      history: [],
      createdAt: NOW,
      updatedAt: NOW
    } as AppState["tasks"][number]);
    state.artifacts.push({
      id: "artifact-c1",
      workspaceId: state.workspace.id,
      ownerType: "task",
      ownerId: "task-c1",
      type: "text",
      name: "Artifact in the deleted Conversation",
      content: "Body.",
      createdAt: NOW,
      updatedAt: NOW
    });
    state.messages.push({
      id: "message-c1",
      workspaceId: state.workspace.id,
      conversationId: DELETED,
      authorType: "employee",
      authorId: state.employees[0].id,
      content: "Message.",
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    });
    state.runs.push({
      id: "run-c1",
      workspaceId: state.workspace.id,
      conversationId: DELETED,
      triggerMessageId: "message-c1",
      memberSnapshot: [],
      status: "completed",
      createdAt: NOW,
      completedAt: NOW
    });
    state.runEvents.push({
      id: "event-c1",
      workspaceId: state.workspace.id,
      runId: "run-c1",
      sequence: 1,
      type: "tool_completed",
      payload: { toolName: "search_history" },
      createdAt: NOW
    });
    // A native reference of every kind, plus one that belongs elsewhere.
    reference(state, { id: "r-message", kind: "message", sourceId: "message-c1" });
    reference(state, { id: "r-turn", kind: "turn", sourceId: turnId });
    reference(state, { id: "r-task", kind: "task", sourceId: "task-c1" });
    reference(state, { id: "r-artifact", kind: "artifact", sourceId: "artifact-c1" });
    reference(state, {
      id: "r-tool-result",
      kind: "tool_result",
      sourceId: "event-c1"
    });
    reference(state, {
      id: "r-external",
      kind: "external_source",
      sourceId: "external:https://example.com/x"
    });
    const store = new MemoryStore(state);

    await service(store).deleteConversation(DELETED);

    const references = await store.read((current) => current.evidenceReferences);
    expect(references.map((item) => item.id)).toEqual(["r-external"]);
  });

  it("keeps a row whose locator names a surviving Conversation", async () => {
    const state = seededState();
    state.messages.push({
      id: "message-c1",
      workspaceId: state.workspace.id,
      conversationId: DELETED,
      authorType: "employee",
      authorId: state.employees[0].id,
      content: "Message.",
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    });
    // The carve-out: the target dies with the Conversation, but the row's
    // locator names a Conversation that survives, so the row is kept — it is
    // the only remaining record of where a surviving Message's citation
    // came from.
    reference(state, {
      id: "r-kept",
      kind: "message",
      sourceId: "message-c1",
      locator: SURVIVOR
    });
    const store = new MemoryStore(state);

    // The update itself is the assertion: the tolerance lets the dangling
    // row through validation where the referential check used to throw.
    await service(store).deleteConversation(DELETED);

    const references = await store.read((current) => current.evidenceReferences);
    expect(references.map((item) => item.id)).toEqual(["r-kept"]);
  });

  it("tolerates a dangling row while keeping every other check", async () => {
    const state = seededState();
    const store = new MemoryStore(state);

    // A dangling row is a legal state: it survives an update.
    await store.update((current) => {
      current.evidenceReferences.push({
        id: "r-dangling",
        workspaceId: current.workspace.id,
        kind: "message",
        sourceId: "message-that-never-existed",
        createdAt: NOW
      });
    });
    expect(
      await store.read((current) =>
        current.evidenceReferences.some((item) => item.id === "r-dangling")
      )
    ).toBe(true);

    // The strict row schema is still enforced.
    await expect(
      store.update((current) => {
        current.evidenceReferences.push({
          id: "r-invalid",
          workspaceId: current.workspace.id,
          kind: "bogus_kind",
          sourceId: "x",
          createdAt: NOW
        } as unknown as EvidenceReference);
      })
    ).rejects.toThrow("Workspace evidenceReferences are invalid");

    // Other ledgers' references are still verified: a Chunk whose Source is
    // gone is refused.
    await expect(
      store.update((current) => {
        current.chunks.push({
          id: "chunk-orphan",
          workspaceId: current.workspace.id,
          sourceId: "source-that-never-existed",
          index: 0,
          content: "Orphan.",
          contentHash: "hash-orphan",
          createdAt: NOW,
          updatedAt: NOW
        });
      })
    ).rejects.toThrow("Workspace chunks are invalid");
  });
});
