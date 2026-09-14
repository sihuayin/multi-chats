import { describe, expect, it } from "vitest";
import { WorkspaceService } from "@/server/application/workspace-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureState,
  noopProviderRegistry,
  TEST_KEY
} from "@/server/test-support/fixtures";

const ALICE = "20000000-0000-4000-8000-000000000001";
const BOB = "20000000-0000-4000-8000-000000000002";

function setup() {
  const store = new MemoryStore(createFixtureState());
  const service = new WorkspaceService(
    store,
    new AesCredentialCipher(TEST_KEY),
    noopProviderRegistry
  );
  return { service, store };
}

describe("Group and Conversation configuration", () => {
  it("copies Group members into a Conversation and keeps the snapshot", async () => {
    const { service, store } = setup();
    const group = await service.createGroup({
      name: "Research Team",
      memberIds: [ALICE]
    });
    const conversation = await service.createConversation({
      title: "Launch",
      groupId: group.id,
      memberIds: []
    });

    expect(conversation.memberIds).toEqual([ALICE]);
    await service.updateGroup(group.id, {
      name: "Edited Team",
      memberIds: [BOB]
    });

    const stored = store
      .snapshot()
      .conversations.find((item) => item.id === conversation.id);
    expect(stored?.memberIds).toEqual([ALICE]);
  });

  it("creates an ad hoc Conversation without a Group", async () => {
    const { service } = setup();

    const conversation = await service.createConversation({
      title: "One-off",
      memberIds: [BOB]
    });

    expect(conversation.groupId).toBeUndefined();
    expect(conversation.memberIds).toEqual([BOB]);
  });

  it("adds and removes Conversation members independently of the source Group", async () => {
    const { service } = setup();
    const group = await service.createGroup({
      name: "Research Team",
      memberIds: [ALICE]
    });
    const conversation = await service.createConversation({
      title: "Launch",
      groupId: group.id,
      memberIds: []
    });

    const expanded = await service.updateConversationMembers(conversation.id, [
      ALICE,
      BOB
    ]);
    expect(expanded.memberIds).toEqual([ALICE, BOB]);

    const reduced = await service.updateConversationMembers(conversation.id, [
      BOB
    ]);
    expect(reduced.memberIds).toEqual([BOB]);
    expect(
      (await service.getWorkspaceView()).groups.find(
        (item) => item.id === group.id
      )?.memberIds
    ).toEqual([ALICE]);
  });

  it("keeps disabled Employees in Groups but excludes them from new Conversations", async () => {
    const { service, store } = setup();
    const group = await service.createGroup({
      name: "Historical Team",
      memberIds: [BOB]
    });
    await store.update((state) => {
      const bob = state.employees.find((employee) => employee.id === BOB);
      if (bob) bob.active = false;
    });

    const updated = await service.updateGroup(group.id, {
      name: "Historical Team Edited",
      memberIds: [BOB]
    });
    const conversation = await service.createConversation({
      title: "New work",
      groupId: group.id,
      memberIds: []
    });

    expect(updated.memberIds).toEqual([BOB]);
    expect(conversation.memberIds).toEqual([]);
    expect(
      (await service.getWorkspaceView()).groups.find(
        (item) => item.id === group.id
      )?.memberIds
    ).toEqual([BOB]);
  });

  it("deletes a Conversation and its related workspace data", async () => {
    const { service, store } = setup();
    const removed = await service.createConversation({
      title: "Remove me",
      memberIds: [ALICE]
    });
    const kept = await service.createConversation({
      title: "Keep me",
      memberIds: [BOB]
    });
    await store.update((state) => {
      state.messages.push({
        id: "message-remove",
        workspaceId: state.workspace.id,
        conversationId: removed.id,
        authorType: "user",
        authorId: "user",
        content: "Remove",
        status: "complete",
        createdAt: state.workspace.createdAt,
        updatedAt: state.workspace.updatedAt
      });
      state.runs.push({
        id: "run-remove",
        workspaceId: state.workspace.id,
        conversationId: removed.id,
        triggerMessageId: "message-remove",
        memberSnapshot: [ALICE],
        status: "completed",
        createdAt: state.workspace.createdAt
      });
      state.runEvents.push({
        id: "event-remove",
        workspaceId: state.workspace.id,
        runId: "run-remove",
        sequence: 1,
        type: "run_completed",
        payload: {},
        createdAt: state.workspace.createdAt
      });
      state.tasks.push({
        id: "task-remove",
        workspaceId: state.workspace.id,
        conversationId: removed.id,
        title: "Remove task",
        goal: "Remove with Conversation.",
        assigneeIds: [ALICE],
        status: "draft",
        history: [],
        createdAt: state.workspace.createdAt,
        updatedAt: state.workspace.updatedAt
      });
      state.artifacts.push({
        id: "artifact-remove",
        workspaceId: state.workspace.id,
        ownerType: "task",
        ownerId: "task-remove",
        type: "text",
        name: "Remove",
        content: "Remove",
        createdAt: state.workspace.createdAt,
        updatedAt: state.workspace.updatedAt
      });
      state.approvals.push({
        id: "approval-remove",
        workspaceId: state.workspace.id,
        runId: "run-remove",
        taskId: "task-remove",
        toolName: "post_webhook",
        args: {},
        status: "cancelled",
        createdAt: state.workspace.createdAt
      });
    });

    await service.deleteConversation(removed.id);
    await expect(
      service.deleteConversation(removed.id)
    ).resolves.toBeUndefined();

    const state = store.snapshot();
    expect(state.conversations.map((item) => item.id)).toEqual([
      "30000000-0000-4000-8000-000000000001",
      kept.id
    ]);
    expect(state.messages).toEqual([]);
    expect(state.runs).toEqual([]);
    expect(state.runEvents).toEqual([]);
    expect(state.tasks).toEqual([]);
    expect(state.artifacts).toEqual([]);
    expect(state.approvals).toEqual([]);
  });
});
