import { ApiError } from "@/server/application/errors";
import {
  artifactInputSchema,
  artifactPatchSchema
} from "@/server/domain/schemas";
import type { AppState, Artifact } from "@/server/domain/types";

function validateContent(type: Artifact["type"], content: string): void {
  if (type !== "json") return;
  try {
    JSON.parse(content);
  } catch {
    throw new ApiError(400, "JSON Artifact content is invalid", "invalid_json");
  }
}

function findTask(state: AppState, taskId: string) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new ApiError(404, "Task not found", "not_found");
  return task;
}

function recordArtifactChange(
  state: AppState,
  taskId: string,
  artifactId: string,
  actorId: string,
  action: "artifact_created" | "artifact_updated",
  timestamp: string
): void {
  const task = findTask(state, taskId);
  task.history.push({
    status: task.status,
    at: timestamp,
    actorId,
    action,
    artifactId
  });
  task.updatedAt = timestamp;
  state.workspace.updatedAt = timestamp;
}

export function createTaskArtifact(
  state: AppState,
  taskId: string,
  input: unknown,
  actorId: string
): Artifact {
  const parsed = artifactInputSchema.parse(input);
  const task = findTask(state, taskId);
  validateContent(parsed.type, parsed.content);
  const timestamp = new Date().toISOString();
  const artifact: Artifact = {
    id: crypto.randomUUID(),
    workspaceId: state.workspace.id,
    taskId: task.id,
    ...parsed,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.artifacts.push(artifact);
  recordArtifactChange(
    state,
    task.id,
    artifact.id,
    actorId,
    "artifact_created",
    timestamp
  );
  return artifact;
}

export function updateTaskArtifact(
  state: AppState,
  taskId: string,
  artifactId: string,
  input: unknown,
  actorId: string
): Artifact {
  const parsed = artifactPatchSchema.parse(input);
  const task = findTask(state, taskId);
  const artifact = state.artifacts.find(
    (item) => item.id === artifactId && item.taskId === task.id
  );
  if (!artifact) {
    throw new ApiError(404, "Artifact not found", "not_found");
  }
  if (parsed.content !== undefined) {
    validateContent(artifact.type, parsed.content);
  }
  const timestamp = new Date().toISOString();
  if (parsed.name !== undefined) artifact.name = parsed.name;
  if (parsed.content !== undefined) artifact.content = parsed.content;
  artifact.updatedAt = timestamp;
  recordArtifactChange(
    state,
    task.id,
    artifact.id,
    actorId,
    "artifact_updated",
    timestamp
  );
  return artifact;
}
