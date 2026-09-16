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
      triggerMessageId: "message-active",
      memberSnapshot: draft.assigneeIds,
      status: "running",
      createdAt: state.workspace.createdAt
    });

    expect(availableTaskActions(state, draft)).toEqual(["cancel"]);
  });

  it("does not offer start for ineligible assignees", () => {
    const state = createFixtureState();
    const inactive = task({ assigneeIds: ["missing-employee"] });

    expect(availableTaskActions(state, inactive)).toEqual(["cancel"]);
  });

  it("keeps server-computed lifecycle actions aligned with Task status", () => {
    const state = createFixtureState();

    expect(availableTaskActions(state, task({ status: "in_progress" }))).toEqual([
      "block",
      "review",
      "cancel"
    ]);
    expect(availableTaskActions(state, task({ status: "blocked" }))).toEqual([
      "resume",
      "review",
      "cancel"
    ]);
    expect(availableTaskActions(state, task({ status: "review" }))).toEqual([
      "return_to_work",
      "complete",
      "cancel"
    ]);
    expect(availableTaskActions(state, task({ status: "completed" }))).toEqual([]);
  });
});
