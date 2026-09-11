import { describe, expect, it } from "vitest";
import { employeeTurnStatuses } from "@/lib/employee-turn-status";
import type { Run, RunEvent } from "@/server/domain/types";

const run: Run = {
  id: "run",
  workspaceId: "workspace",
  conversationId: "conversation",
  triggerMessageId: "message",
  memberSnapshot: ["alice", "bob", "carol"],
  status: "running",
  createdAt: "2026-01-01T00:00:00.000Z"
};

function event(
  sequence: number,
  type: RunEvent["type"],
  payload: Record<string, unknown>
): RunEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace",
    runId: "run",
    sequence,
    type,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("employeeTurnStatuses", () => {
  it("derives queued, active, and completed states in member order", () => {
    const statuses = employeeTurnStatuses(run, [
      event(1, "employee_turn_started", { employeeId: "alice" }),
      event(2, "employee_turn_completed", { employeeId: "alice" }),
      event(3, "employee_turn_started", { employeeId: "bob" })
    ]);

    expect([...statuses.entries()]).toEqual([
      ["alice", "completed"],
      ["bob", "active"],
      ["carol", "queued"]
    ]);
  });

  it("marks a failed Employee turn explicitly", () => {
    const statuses = employeeTurnStatuses(run, [
      event(1, "employee_turn_started", { employeeId: "alice" }),
      event(2, "employee_turn_failed", { employeeId: "alice" })
    ]);

    expect(statuses.get("alice")).toBe("failed");
  });

  it("distinguishes a cancelled Employee turn from failure", () => {
    const statuses = employeeTurnStatuses(run, [
      event(1, "employee_turn_started", { employeeId: "alice" }),
      event(2, "employee_turn_cancelled", { employeeId: "alice" })
    ]);

    expect(statuses.get("alice")).toBe("cancelled");
  });
});
