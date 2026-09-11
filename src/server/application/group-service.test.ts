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
});
