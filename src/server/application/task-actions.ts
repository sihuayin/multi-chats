import type { AppState, Task, TaskAction } from "@/server/domain/types";

type TaskActionState = Pick<
  AppState,
  "conversations" | "employees" | "runs"
>;

export function availableTaskActions(
  state: TaskActionState,
  task: Task
): TaskAction[] {
  const actions: TaskAction[] = [];
  const conversation = state.conversations.find(
    (item) => item.id === task.conversationId
  );
  const conversationMemberIds = new Set(conversation?.memberIds ?? []);
  const uniqueAssigneeIds = new Set(task.assigneeIds);
  const assigneesAreEligible =
    task.assigneeIds.length > 0 &&
    uniqueAssigneeIds.size === task.assigneeIds.length &&
    task.assigneeIds.every((employeeId) => {
      const employee = state.employees.find((item) => item.id === employeeId);
      return Boolean(employee?.active && conversationMemberIds.has(employeeId));
    });
  const activeRun = state.runs.some(
    (run) =>
      run.conversationId === task.conversationId &&
      ["queued", "running", "waiting_approval"].includes(run.status)
  );

  if (task.status === "draft" && !activeRun && assigneesAreEligible) {
    actions.push("start");
  }
  if (task.status === "in_progress") {
    actions.push("block", "review");
  } else if (task.status === "blocked") {
    actions.push("resume", "review");
  } else if (task.status === "review") {
    actions.push("return_to_work", "complete");
  }
  if (task.status !== "completed" && task.status !== "cancelled") {
    actions.push("cancel");
  }
  return actions;
}
