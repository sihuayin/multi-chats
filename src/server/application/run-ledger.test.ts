import { describe, expect, it } from "vitest";
import { appendEvent } from "@/server/application/run-ledger";
import type { Run } from "@/server/domain/types";
import { createInitialState } from "@/server/store/initial-state";

describe("Run event ledger", () => {
  it("uses the supplied deterministic clock and identifier generator", () => {
    const state = createInitialState("00000000-0000-4000-8000-000000000001");
    const run: Run = {
      id: "run-1",
      workspaceId: state.workspace.id,
      conversationId: "conversation-1",
      triggerMessageId: "message-1",
      memberSnapshot: ["employee-1"],
      status: "running",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    let id = 0;
    const factory = {
      id: () => `event-${++id}`,
      now: () => `2026-01-01T00:00:0${id}.000Z`
    };

    const first = appendEvent(state, run, "run_started", {}, factory);
    const second = appendEvent(
      state,
      run,
      "employee_turn_started",
      { employeeId: "employee-1" },
      factory
    );

    expect(first).toMatchObject({
      id: "event-1",
      sequence: 1,
      createdAt: "2026-01-01T00:00:01.000Z"
    });
    expect(second).toMatchObject({
      id: "event-2",
      sequence: 2,
      createdAt: "2026-01-01T00:00:02.000Z"
    });
    expect(state.runEvents.map((event) => event.sequence)).toEqual([1, 2]);
  });
});
