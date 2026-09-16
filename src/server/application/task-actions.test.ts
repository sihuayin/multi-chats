import { describe, expect, it } from "vitest";
import { availableTaskActions } from "@/server/application/task-actions";
import type { Task } from "@/server/domain/types";
import { createFixtureState } from "@/server/test-support/fixtures";

function task(overrides: Partial<Task> = {}): Task {
  const state = createFixtureState();
  return {
    id: "task-actions",
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id,
    title: "Actionable Task",
    goal: "Expose only valid actions.",
    assigneeIds: [state.employees[0].id],
    status: "draft",
    history: [],
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt,
    ...overrides
  };
}

describe("availableTaskActions", () => {
  it("allows start only for an eligible draft Task without an active Run", () => {
    const state = createFixtureState();
    const draft = task();

    expect(availableTaskActions(state, draft)).toEqual(["start", "cancel"]);

    state.runs.push({
      id: "run-active",
      workspaceId: state.workspace.id,
      conversationId: draft.conversationId,
      taskId: draft.id,
      triggerMessageId: "message-active",
      memberSnapshot: draft.assigneeIds,
      status: "running",
      createdAt: state.workspace.createdAt
    });

    expect(availableTaskActions(state, draft)).toEqual(["stop", "cancel"]);
  });

  it("does not offer start for ineligible assignees", () => {
    const state = createFixtureState();
    const inactive = task({ assigneeIds: ["missing-employee"] });

    expect(availableTaskActions(state, inactive)).toEqual(["cancel"]);
  });

  it("keeps server-computed lifecycle actions aligned with Task status", () => {
    const state = createFixtureState();

    expect(availableTaskActions(state, task({ status: "in_progress" }))).toEqual([
      "start",
      "block",
      "review",
      "cancel"
    ]);
    expect(availableTaskActions(state, task({ status: "blocked" }))).toEqual([
      "start",
      "resume",
      "review",
      "cancel"
    ]);
    expect(availableTaskActions(state, task({ status: "review" }))).toEqual([
      "start",
      "return_to_work",
      "complete",
      "cancel"
    ]);
    expect(availableTaskActions(state, task({ status: "completed" }))).toEqual([]);
  });

  it("offers resume for an interrupted Task Run and start again after settlement", () => {
    const state = createFixtureState();
    const draft = task({ status: "in_progress" });
    state.runs.push({
      id: "run-interrupted",
      workspaceId: state.workspace.id,
      conversationId: draft.conversationId,
      taskId: draft.id,
      triggerMessageId: "message-interrupted",
      memberSnapshot: draft.assigneeIds,
      status: "interrupted",
      createdAt: state.workspace.createdAt
    });

    expect(availableTaskActions(state, draft)).toEqual([
      "resume_run",
      "block",
      "review",
      "cancel"
    ]);

    state.runs[0].status = "completed";
    expect(availableTaskActions(state, draft)).toEqual([
      "start",
      "block",
      "review",
      "cancel"
    ]);
  });

  it("does not offer resume while another Conversation Run is active", () => {
    const state = createFixtureState();
    const draft = task({ status: "in_progress" });
    state.runs.push(
      {
        id: "run-interrupted",
        workspaceId: state.workspace.id,
        conversationId: draft.conversationId,
        taskId: draft.id,
        triggerMessageId: "message-interrupted",
        memberSnapshot: draft.assigneeIds,
        status: "interrupted",
        createdAt: state.workspace.createdAt
      },
      {
        id: "run-active",
        workspaceId: state.workspace.id,
        conversationId: draft.conversationId,
        triggerMessageId: "message-active",
        memberSnapshot: draft.assigneeIds,
        status: "running",
        createdAt: state.workspace.createdAt
      }
    );

    expect(availableTaskActions(state, draft)).toEqual([
      "block",
      "review",
      "cancel"
    ]);
  });
});
