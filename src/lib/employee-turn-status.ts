import type { Run, RunEvent } from "@/server/domain/types";

export type EmployeeTurnStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed";

export function employeeTurnStatuses(
  run: Run,
  events: RunEvent[]
): Map<string, EmployeeTurnStatus> {
  const statuses = new Map<string, EmployeeTurnStatus>(
    run.memberSnapshot.map((employeeId) => [employeeId, "queued"])
  );
  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence
  );

  for (const event of ordered) {
    const employeeId =
      typeof event.payload.employeeId === "string"
        ? event.payload.employeeId
        : undefined;
    if (!employeeId || !statuses.has(employeeId)) continue;

    if (event.type === "employee_turn_started") {
      statuses.set(employeeId, "active");
    } else if (event.type === "employee_turn_completed") {
      statuses.set(employeeId, "completed");
    } else if (event.type === "employee_turn_failed") {
      statuses.set(employeeId, "failed");
    }
  }

  return statuses;
}
