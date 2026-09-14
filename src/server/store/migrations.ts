import type { AppState } from "@/server/domain/types";
import { isArtifactType } from "@/lib/artifact-types";
import { validateRuntimeContracts } from "@/server/domain/runtime-contracts";
import {
  validateDiscussion,
  validateDiscussionReferences
} from "@/server/application/discussion-domain";

export const CURRENT_SCHEMA_VERSION = 4;

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
  state.schemaVersion = 2;
}

function migrateV2ToV3(state: Record<string, unknown>): void {
  for (const key of [
    "providerAttempts",
    "evidenceReferences",
    "discussionCompressions",
    "discussionInterventions",
    "discussionContextRevisions",
    "modelPricing"
  ]) {
    state[key] ??= [];
  }
  state.schemaVersion = 3;
}

function migrateV3ToV4(state: Record<string, unknown>): void {
  if (!Array.isArray(state.discussionCompressions)) {
    throw new Error("Workspace discussionCompressions are invalid");
  }
  for (const value of state.discussionCompressions) {
    const compression = record(value);
    compression.sourceSpanHash ??=
      `legacy:${String(compression.contentHash ?? compression.id ?? "unknown")}`;
    compression.strategy ??= "extractive";
    compression.compressionProfileVersion ??= "legacy";
  }
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
  if (!Array.isArray(state.employees)) {
    throw new Error("Workspace Employees are invalid");
  }
  const workspace = record(state.workspace);
  const workspaceId = workspace.id;
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new Error("Workspace identity is invalid");
  }
  validateRuntimeContracts(state, workspaceId);
  validateDiscussionReferences({
    discussions: state.discussions as never,
    artifacts: state.artifacts as never,
    messages: state.messages as never,
    runs: state.runs as never,
    tasks: state.tasks as never
  });
}

export function migrateAppState(input: unknown): AppState {
  const state = structuredClone(record(input));
  const version = state.schemaVersion;
  if (version === undefined || version === 1) {
    migrateV1ToV2(state);
  }
  if (state.schemaVersion === 2) migrateV2ToV3(state);
  if (state.schemaVersion === 3) migrateV3ToV4(state);
  if (version !== CURRENT_SCHEMA_VERSION) {
    if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported Workspace schema version: ${String(version)}`
      );
    }
  }
  validateCurrentState(state);
  return state as unknown as AppState;
}
