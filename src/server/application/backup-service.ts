import type { AppState } from "@/server/domain/types";
import { isArtifactType } from "@/lib/artifact-types";
import {
  validateDiscussion,
  validateDiscussionReferences
} from "@/server/application/discussion-domain";
import { CURRENT_SCHEMA_VERSION } from "@/server/store/migrations";
import type { StateStore } from "@/server/store/store";

const stateArrayKeys = Object.keys({
  providers: true,
  employees: true,
  skills: true,
  groups: true,
  conversations: true,
  messages: true,
  runs: true,
  runEvents: true,
  tasks: true,
  artifacts: true,
  discussions: true,
  approvals: true
} satisfies Record<
  Exclude<
    keyof AppState,
    "workspace" | "schemaVersion" | "idempotencyRecords"
  >,
  true
>);

const runStatuses = new Set([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);
const taskStatuses = new Set([
  "draft",
  "in_progress",
  "blocked",
  "review",
  "completed",
  "cancelled"
]);
const approvalStatuses = new Set([
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "expired"
]);
const messageStatuses = new Set([
  "complete",
  "streaming",
  "failed",
  "cancelled",
  "interrupted"
]);
const messageAuthors = new Set(["user", "employee", "system"]);

function invalid(): never {
  throw new Error("Backup file is invalid");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string {
  const field = value[key];
  if (typeof field !== "string" || !field) invalid();
  return field;
}

function stringArrayField(
  value: Record<string, unknown>,
  key: string
): string[] {
  const field = value[key];
  if (
    !Array.isArray(field) ||
    field.some((item) => typeof item !== "string")
  ) {
    invalid();
  }
  return field;
}

function validateState(candidate: Record<string, unknown>): void {
  if (candidate.schemaVersion !== CURRENT_SCHEMA_VERSION) invalid();
  const workspace = record(candidate.workspace);
  const workspaceId = stringField(workspace, "id");
  stringField(workspace, "name");
  stringField(workspace, "createdAt");
  stringField(workspace, "updatedAt");
  if (stateArrayKeys.some((key) => !Array.isArray(candidate[key]))) invalid();

  const array = (key: string) => candidate[key] as unknown[];
  const workspaceRecords = (key: string) =>
    array(key).map((item) => {
      const value = record(item);
      if (stringField(value, "workspaceId") !== workspaceId) invalid();
      stringField(value, "id");
      return value;
    });

  workspaceRecords("providers").forEach((provider) => {
    stringField(provider, "provider");
    stringField(provider, "label");
    stringField(provider, "encryptedCredential");
  });
  workspaceRecords("employees").forEach((employee) => {
    stringField(employee, "name");
    stringField(employee, "identity");
    stringField(employee, "providerCredentialId");
    stringField(employee, "modelId");
    stringArrayField(employee, "skillIds");
    if (typeof employee.active !== "boolean") invalid();
  });
  workspaceRecords("skills").forEach((skill) => {
    stringField(skill, "name");
    stringField(skill, "description");
    stringField(skill, "instructions");
    stringArrayField(skill, "inputs");
    stringArrayField(skill, "outputs");
    stringArrayField(skill, "toolNames");
    if (typeof skill.builtIn !== "boolean") invalid();
  });
  workspaceRecords("groups").forEach((group) => {
    stringField(group, "name");
    stringArrayField(group, "memberIds");
  });
  workspaceRecords("conversations").forEach((conversation) => {
    stringField(conversation, "title");
    stringArrayField(conversation, "memberIds");
  });
  workspaceRecords("messages").forEach((message) => {
    stringField(message, "conversationId");
    stringField(message, "authorId");
    stringField(message, "content");
    if (!messageAuthors.has(stringField(message, "authorType"))) invalid();
    if (!messageStatuses.has(stringField(message, "status"))) invalid();
  });
  workspaceRecords("runs").forEach((run) => {
    stringField(run, "conversationId");
    stringField(run, "triggerMessageId");
    stringArrayField(run, "memberSnapshot");
    if (!runStatuses.has(stringField(run, "status"))) invalid();
  });
  workspaceRecords("runEvents").forEach((event) => {
    stringField(event, "runId");
    stringField(event, "type");
    if (!Number.isInteger(event.sequence)) invalid();
    record(event.payload);
  });
  workspaceRecords("tasks").forEach((task) => {
    stringField(task, "conversationId");
    stringField(task, "title");
    stringField(task, "goal");
    stringArrayField(task, "assigneeIds");
    if (!taskStatuses.has(stringField(task, "status"))) invalid();
    if (!Array.isArray(task.history)) invalid();
  });
  workspaceRecords("artifacts").forEach((artifact) => {
    if (
      artifact.ownerType !== "task" &&
      artifact.ownerType !== "discussion"
    ) {
      invalid();
    }
    stringField(artifact, "ownerId");
    if (!isArtifactType(artifact.type)) invalid();
    stringField(artifact, "name");
    stringField(artifact, "content");
  });
  workspaceRecords("approvals").forEach((approval) => {
    stringField(approval, "runId");
    stringField(approval, "toolName");
    record(approval.args);
    if (!approvalStatuses.has(stringField(approval, "status"))) invalid();
  });
  workspaceRecords("discussions").forEach((discussion) => {
    try {
      validateDiscussion(discussion as never);
    } catch {
      invalid();
    }
  });

  const ids = (key: string) =>
    new Set(array(key).map((item) => stringField(record(item), "id")));
  const providerIds = ids("providers");
  const employeeIds = ids("employees");
  const skillIds = ids("skills");
  const conversationIds = ids("conversations");
  const messageIds = ids("messages");
  const runIds = ids("runs");
  const taskIds = ids("tasks");
  const discussionIds = ids("discussions");

  workspaceRecords("employees").forEach((employee) => {
    if (!providerIds.has(stringField(employee, "providerCredentialId"))) invalid();
    if (
      stringArrayField(employee, "skillIds").some((id) => !skillIds.has(id))
    ) {
      invalid();
    }
  });
  workspaceRecords("groups").forEach((group) => {
    if (
      stringArrayField(group, "memberIds").some((id) => !employeeIds.has(id))
    ) {
      invalid();
    }
  });
  workspaceRecords("conversations").forEach((conversation) => {
    if (
      stringArrayField(conversation, "memberIds").some(
        (id) => !employeeIds.has(id)
      )
    ) {
      invalid();
    }
  });
  workspaceRecords("messages").forEach((message) => {
    if (!conversationIds.has(stringField(message, "conversationId"))) invalid();
  });
  workspaceRecords("runs").forEach((run) => {
    if (!conversationIds.has(stringField(run, "conversationId"))) invalid();
    if (!messageIds.has(stringField(run, "triggerMessageId"))) invalid();
    if (
      stringArrayField(run, "memberSnapshot").some(
        (id) => !employeeIds.has(id)
      )
    ) {
      invalid();
    }
  });
  workspaceRecords("runEvents").forEach((event) => {
    if (!runIds.has(stringField(event, "runId"))) invalid();
  });
  workspaceRecords("tasks").forEach((task) => {
    if (!conversationIds.has(stringField(task, "conversationId"))) invalid();
    if (
      stringArrayField(task, "assigneeIds").some((id) => !employeeIds.has(id))
    ) {
      invalid();
    }
  });
  workspaceRecords("artifacts").forEach((artifact) => {
    const ownerId = stringField(artifact, "ownerId");
    if (artifact.ownerType === "task" && !taskIds.has(ownerId)) invalid();
    if (artifact.ownerType === "discussion" && !discussionIds.has(ownerId)) {
      invalid();
    }
  });
  workspaceRecords("approvals").forEach((approval) => {
    if (!runIds.has(stringField(approval, "runId"))) invalid();
  });
  try {
    validateDiscussionReferences({
      discussions: array("discussions") as never,
      artifacts: array("artifacts") as never,
      messages: array("messages") as never,
      runs: array("runs") as never,
      tasks: array("tasks") as never
    });
  } catch {
    invalid();
  }
}

export async function createWorkspaceBackup(store: StateStore): Promise<string> {
  const state = await store.read((current) => current);
  return JSON.stringify(state, null, 2);
}

export function parseWorkspaceBackup(input: string): AppState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Backup file is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  validateState(parsed as Record<string, unknown>);
  return parsed as AppState;
}

export async function restoreWorkspaceBackup(
  store: StateStore,
  input: string
): Promise<AppState> {
  const backup = parseWorkspaceBackup(input);
  await store.migrate?.();
  await store.update((state) => {
    Object.assign(state, structuredClone(backup));
  });
  return backup;
}
