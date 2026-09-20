import type { AppState, Tool } from "@/server/domain/types";
import { isArtifactType } from "@/lib/artifact-types";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import { validateRuntimeContracts } from "@/server/domain/runtime-contracts";
import {
  validateDiscussion,
  validateDiscussionReferences
} from "@/server/application/discussion-domain";

export const CURRENT_SCHEMA_VERSION = 7;

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
  state.schemaVersion = 4;
}

function migrateV4ToV5(state: Record<string, unknown>): void {
  state.sources ??= [];
  state.chunks ??= [];
  if (!Array.isArray(state.sources)) {
    throw new Error("Workspace Sources are invalid");
  }
  if (!Array.isArray(state.chunks)) {
    throw new Error("Workspace Chunks are invalid");
  }
  if (!Array.isArray(state.discussions)) {
    throw new Error("Workspace Discussions are invalid");
  }
  for (const value of state.discussions) {
    const discussion = record(value);
    discussion.sourceIds ??= [];
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
  // Every Tool a Skill allows must resolve. Skills are live configuration, not
  // history, so write-time validation is what keeps this true; reaching it here
  // means a bad restore or a bug, and refusing to load is safer than running a
  // Skill that references nothing.
  const toolNames = new Set(
    (state.tools as unknown[]).map((item) => record(item).name)
  );
  for (const value of state.skills as unknown[]) {
    const skill = record(value);
    const names = Array.isArray(skill.toolNames) ? skill.toolNames : [];
    for (const name of names) {
      if (typeof name !== "string" || !toolNames.has(name)) {
        throw new Error(
          `Workspace Skill ${String(skill.name ?? skill.id)} references unknown Tool ${String(name)}`
        );
      }
    }
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

/**
 * The built-ins as registry entries, built from the code constant that stays
 * the authority: because these entries cannot be edited, a later migration may
 * safely overwrite them from here.
 *
 * Lives beside the migration rather than in `initial-state` so the seeding and
 * the schema version move together, and `initial-state` keeps its one-way
 * import.
 */
export function seedBuiltInTools(
  workspaceId: string,
  timestamp: string
): Tool[] {
  return BUILT_IN_TOOLS.map((tool) => ({
    ...structuredClone(tool),
    id: `builtin:${tool.name}`,
    workspaceId,
    builtIn: true,
    active: true,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
}

function migrateV5ToV6(state: Record<string, unknown>): void {
  state.tools ??= [];
  if (!Array.isArray(state.tools)) {
    throw new Error("Workspace Tools are invalid");
  }
  const workspace = record(state.workspace);
  const workspaceId = typeof workspace.id === "string" ? workspace.id : "";
  const timestamp =
    typeof workspace.updatedAt === "string" && workspace.updatedAt
      ? workspace.updatedAt
      : typeof workspace.createdAt === "string" && workspace.createdAt
        ? workspace.createdAt
        : new Date().toISOString();

  const seeded = new Set(
    state.tools.map((item) => record(item).id)
  );
  for (const tool of seedBuiltInTools(workspaceId, timestamp)) {
    if (!seeded.has(tool.id)) state.tools.push(tool);
  }
  workspace.egressAllowlist ??= [];
  state.schemaVersion = 6;
}

function migrateV6ToV7(state: Record<string, unknown>): void {
  if (!Array.isArray(state.tools)) {
    throw new Error("Workspace Tools are invalid");
  }
  for (const value of state.tools) {
    const tool = record(value);
    tool.active ??= true;
  }
  state.schemaVersion = CURRENT_SCHEMA_VERSION;
}

export function migrateAppState(input: unknown): AppState {
  const state = structuredClone(record(input));
  const version = state.schemaVersion;
  if (version === undefined || version === 1) {
    migrateV1ToV2(state);
  }
  if (state.schemaVersion === 2) migrateV2ToV3(state);
  if (state.schemaVersion === 3) migrateV3ToV4(state);
  if (state.schemaVersion === 4) migrateV4ToV5(state);
  if (state.schemaVersion === 5) migrateV5ToV6(state);
  if (state.schemaVersion === 6) migrateV6ToV7(state);
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
