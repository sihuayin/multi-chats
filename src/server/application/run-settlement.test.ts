import { describe, expect, it } from "vitest";
import { settleRun } from "@/server/application/run-settlement";
import type { AppState, Run } from "@/server/domain/types";
import { createFixtureState } from "@/server/test-support/fixtures";

function addRun(state: AppState): Run {
  const run: Run = {
    id: "run-settlement",
    workspaceId: state.workspace.id,
    conversationId: "30000000-0000-4000-8000-000000000001",
    triggerMessageId: "trigger-message",
    requestId: "request-settlement",
    memberSnapshot: ["20000000-0000-4000-8000-000000000001"],
    status: "running",
    startedAt: state.workspace.createdAt,
    createdAt: state.workspace.createdAt
  };
  state.runs.push(run);
  return run;
}

function deterministicFactory() {
  let id = 0;
  return {
    id: () => `settlement-event-${++id}`,
    now: () => "2026-01-01T00:00:05.000Z"
  };
}

describe("Run settlement", () => {
  it("settles cancelled Runs in canonical order", () => {
    const state = createFixtureState();
    const run = addRun(state);
    state.messages.push({
      id: "streaming-message",
      workspaceId: state.workspace.id,
      conversationId: run.conversationId,
      authorType: "employee",
      authorId: "20000000-0000-4000-8000-000000000001",
      content: "partial",
      runId: run.id,
      status: "streaming",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.approvals.push({
      id: "pending-approval",
      workspaceId: state.workspace.id,
      runId: run.id,
      messageId: "streaming-message",
      taskId: "task-1",
      employeeId: "20000000-0000-4000-8000-000000000001",
      toolCallId: "tool-call-1",
      toolName: "post_webhook",
      args: {},
      status: "pending",
      createdAt: state.workspace.createdAt
    });

    const result = settleRun(state, {
      runId: run.id,
      outcome: "cancelled",
      reason: "run_cancelled",
      cooperative: true,
      stopRequested: true,
      eventFactory: deterministicFactory()
    });

    expect(result).toEqual({
      settled: true,
      runId: run.id,
      outcome: "cancelled",
      affectedMessageIds: ["streaming-message"],
      affectedApprovalIds: ["pending-approval"],
      completedAt: "2026-01-01T00:00:05.000Z"
    });
    expect(run).toMatchObject({
      status: "cancelled",
      completedAt: "2026-01-01T00:00:05.000Z"
    });
    expect(state.messages[0].status).toBe("cancelled");
    expect(state.approvals[0]).toMatchObject({
      status: "cancelled",
      resolvedAt: "2026-01-01T00:00:05.000Z"
    });
    expect(state.runEvents.map((event) => event.type)).toEqual([
      "approval_resolved",
      "employee_turn_partial",
      "employee_turn_cancelled",
      "run_cancelled"
    ]);
    expect(state.runEvents.map((event) => event.createdAt)).toEqual(
      Array(4).fill("2026-01-01T00:00:05.000Z")
    );
    expect(state.runEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(state.workspace.updatedAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("settles failed and interrupted Runs", () => {
    const failedState = createFixtureState();
    const failedRun = addRun(failedState);
    failedState.messages.push({
      id: "failed-message",
      workspaceId: failedState.workspace.id,
      conversationId: failedRun.conversationId,
      authorType: "employee",
      authorId: "20000000-0000-4000-8000-000000000001",
      content: "",
      runId: failedRun.id,
      status: "streaming",
      createdAt: failedState.workspace.createdAt,
      updatedAt: failedState.workspace.updatedAt
    });
    settleRun(failedState, {
      runId: failedRun.id,
      outcome: "failed",
      reason: "model_error",
      error: "model failed",
      eventFactory: deterministicFactory()
    });
    expect(failedRun).toMatchObject({
      status: "failed",
      error: "model failed"
    });
    expect(failedState.messages[0].status).toBe("failed");
    expect(failedState.runEvents.map((event) => event.type)).toEqual([
      "employee_turn_failed",
      "run_error"
    ]);

    const interruptedState = createFixtureState();
    const interruptedRun = addRun(interruptedState);
    settleRun(interruptedState, {
      runId: interruptedRun.id,
      outcome: "interrupted",
      reason: "worker_restart",
      error: "Worker restarted while the Run was active",
      interrupted: true,
      eventFactory: deterministicFactory()
    });
    expect(interruptedRun.status).toBe("interrupted");
    expect(interruptedState.runEvents.at(-1)?.payload).toMatchObject({
      reason: "worker_restart",
      interrupted: true
    });
  });

  it("is a no-op for an already terminal Run", () => {
    const state = createFixtureState();
    const run = addRun(state);
    run.status = "failed";
    run.completedAt = "2026-01-01T00:00:01.000Z";

    const result = settleRun(state, {
      runId: run.id,
      outcome: "cancelled",
      reason: "run_cancelled",
      cooperative: true,
      stopRequested: false,
      eventFactory: deterministicFactory()
    });

    expect(result).toMatchObject({
      settled: false,
      outcome: "cancelled",
      completedAt: "2026-01-01T00:00:01.000Z"
    });
    expect(run.status).toBe("failed");
    expect(state.runEvents).toEqual([]);

    run.status = "interrupted";
    const interruptedResult = settleRun(state, {
      runId: run.id,
      outcome: "cancelled",
      reason: "run_cancelled",
      cooperative: true,
      stopRequested: false,
      eventFactory: deterministicFactory()
    });
    expect(interruptedResult.settled).toBe(false);
    expect(run.status).toBe("interrupted");
  });

  it("rejects completion while a Message is still streaming", () => {
    const state = createFixtureState();
    const run = addRun(state);
    state.messages.push({
      id: "streaming-message",
      workspaceId: state.workspace.id,
      conversationId: run.conversationId,
      authorType: "employee",
      authorId: "20000000-0000-4000-8000-000000000001",
      content: "",
      runId: run.id,
      status: "streaming",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });

    expect(() =>
      settleRun(state, {
        runId: run.id,
        outcome: "completed",
        reason: "run_completed"
      })
    ).toThrow("Completed Run cannot have streaming Messages");
  });

  it("rejects an unknown Run", () => {
    expect(() =>
      settleRun(createFixtureState(), {
        runId: "missing-run",
        outcome: "completed",
        reason: "run_completed"
      })
    ).toThrow("Run not found");
  });
});
