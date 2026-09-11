import type { Task, TaskStatus } from "@/server/domain/types";
import { ApiError } from "@/server/application/errors";

const employeeTransitions: Partial<Record<TaskStatus, TaskStatus[]>> = {
  draft: ["in_progress", "blocked", "cancelled"],
  in_progress: ["blocked", "review", "cancelled"],
  blocked: ["in_progress", "review", "cancelled"],
  review: ["in_progress"]
};

export function transitionTask(
  task: Task,
  next: TaskStatus,
  actorId: string
): void {
  const current = task.status;
  if (next === "completed") {
    if (actorId !== "user") {
      throw new ApiError(403, "Only the user can complete a Task", "task_completion");
    }
    if (current !== "review") {
      throw new ApiError(
        409,
        "Task must be in review before completion",
        "task_transition"
      );
    }
  } else if (next !== "cancelled" || actorId !== "user") {
    const allowed = employeeTransitions[current] ?? [];
    if (!allowed.includes(next)) {
      throw new ApiError(
        409,
        `Task cannot move from ${current} to ${next}`,
        "task_transition"
      );
    }
  }

  task.status = next;
  task.history.push({
    status: next,
    at: new Date().toISOString(),
    actorId
  });
  task.updatedAt = task.history.at(-1)!.at;
}
