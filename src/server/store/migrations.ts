import type { AppState } from "@/server/domain/types";
import { isArtifactType } from "@/lib/artifact-types";
import {
  validateDiscussion,
  validateDiscussionReferences
} from "@/server/application/discussion-domain";

export const CURRENT_SCHEMA_VERSION = 2;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace state is invalid");
  }
  return value as Record<string, unknown>;
}

function migrateV1ToV2(state: Record<string, unknown>): void {
  if (!Array.isArray(state.artifacts)) {
    throw new Error("Workspace Artifacts are invalid");
  }
  for (const value of state.artifacts) {
    const artifact = record(value);
    const hasOwnerFields =
      artifact.ownerType !== undefined || artifact.ownerId !== undefined;
    const validOwner =
      (artifact.ownerType === "task" ||
        artifact.ownerType === "discussion") &&
      typeof artifact.ownerId === "string" &&
      artifact.ownerId.length > 0;

    if (hasOwnerFields) {
      if (!validOwner) {
        throw new Error("Workspace Artifact owner is invalid");
      }
      if (artifact.taskId !== undefined) {
        if (
          typeof artifact.taskId !== "string" ||
          !artifact.taskId ||
          artifact.ownerType !== "task" ||
          artifact.taskId !== artifact.ownerId
        ) {
          throw new Error("Workspace Artifact owner is invalid");
        }
        delete artifact.taskId;
      }
      continue;
    }

    const taskId = artifact.taskId;
    if (typeof taskId !== "string" || !taskId) {
      throw new Error("Workspace Artifact owner is invalid");
    }
    artifact.ownerType = "task";
    artifact.ownerId = taskId;
    delete artifact.taskId;
  }
  state.discussions = [];
  state.schemaVersion = CURRENT_SCHEMA_VERSION;
}

function validateCurrentState(state: Record<string, unknown>): void {
  if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Workspace schema version: ${String(state.schemaVersion)}`
    );
  }
  if (!Array.isArray(state.artifacts)) {
    throw new Error("Workspace Artifacts are invalid");
  }
  for (const value of state.artifacts) {
    const artifact = record(value);
    if (
      (artifact.ownerType !== "task" &&
        artifact.ownerType !== "discussion") ||
      typeof artifact.ownerId !== "string" ||
      !artifact.ownerId ||
      artifact.taskId !== undefined ||
      !isArtifactType(artifact.type) ||
      typeof artifact.name !== "string" ||
      typeof artifact.content !== "string"
    ) {
      throw new Error("Workspace Artifact is invalid");
    }
  }
  if (!Array.isArray(state.discussions)) {
    throw new Error("Workspace Discussions are invalid");
  }
  state.discussions.forEach((value) => {
    validateDiscussion(record(value) as never);
  });
  if (!Array.isArray(state.messages) || !Array.isArray(state.runs)) {
    throw new Error("Workspace correlations are invalid");
  }
  validateDiscussionReferences({
    discussions: state.discussions as never,
    artifacts: state.artifacts as never,
    messages: state.messages as never,
    runs: state.runs as never
  });
}

export function migrateAppState(input: unknown): AppState {
  const state = structuredClone(record(input));
  const version = state.schemaVersion;
  if (version === undefined || version === 1) {
    migrateV1ToV2(state);
    validateCurrentState(state);
    return state as unknown as AppState;
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported Workspace schema version: ${String(version)}`);
  }
  validateCurrentState(state);
  return state as unknown as AppState;
}
