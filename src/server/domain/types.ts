import type { ProviderId } from "@/lib/provider-catalog";

import type { ArtifactType } from "@/lib/artifact-types";

export type IsoDate = string;

export type Workspace = {
  id: string;
  name: string;
  workerHeartbeatAt?: IsoDate;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type ProviderCredential = {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  label: string;
  encryptedCredential: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type { ProviderId } from "@/lib/provider-catalog";

export type Employee = {
  id: string;
  workspaceId: string;
  name: string;
  identity: string;
  providerCredentialId: string;
  modelId: string;
  skillIds: string[];
  active: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type Skill = {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  inputs: string[];
  outputs: string[];
  toolNames: string[];
  builtIn: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  risk: "read" | "write";
  requiresApproval: boolean;
  replay: "never" | "safe";
  inputSchema: Record<string, unknown>;
};

export type Group = {
  id: string;
  workspaceId: string;
  name: string;
  memberIds: string[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type Conversation = {
  id: string;
  workspaceId: string;
  title: string;
  groupId?: string;
  memberIds: string[];
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type Message = {
  id: string;
  workspaceId: string;
  conversationId: string;
  authorType: "user" | "employee" | "system";
  authorId: string;
  content: string;
  runId?: string;
  status: "complete" | "streaming" | "failed" | "cancelled" | "interrupted";
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type Run = {
  id: string;
  workspaceId: string;
  conversationId: string;
  triggerMessageId: string;
  memberSnapshot: string[];
  status: RunStatus;
  error?: string;
  createdAt: IsoDate;
  startedAt?: IsoDate;
  completedAt?: IsoDate;
};

export type RunEvent = {
  id: string;
  workspaceId: string;
  runId: string;
  sequence: number;
  type:
    | "run_started"
    | "employee_turn_started"
    | "employee_turn_completed"
    | "employee_turn_failed"
    | "employee_turn_cancelled"
    | "employee_turn_interrupted"
    | "message_delta"
    | "message_completed"
    | "tool_started"
    | "tool_completed"
    | "tool_cancelled"
    | "approval_requested"
    | "approval_resolved"
    | "task_changed"
    | "artifact_created"
    | "model_error"
    | "tool_error"
    | "run_error"
    | "run_cancelled"
    | "run_completed";
  payload: Record<string, unknown>;
  createdAt: IsoDate;
};

export type TaskStatus =
  | "draft"
  | "in_progress"
  | "blocked"
  | "review"
  | "completed"
  | "cancelled";

export type Task = {
  id: string;
  workspaceId: string;
  conversationId: string;
  title: string;
  goal: string;
  assigneeIds: string[];
  status: TaskStatus;
  history: Array<{
    status: TaskStatus;
    at: IsoDate;
    actorId: string;
    action?: string;
    artifactId?: string;
  }>;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type Artifact = {
  id: string;
  workspaceId: string;
  taskId: string;
  type: ArtifactType;
  name: string;
  content: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type Approval = {
  id: string;
  workspaceId: string;
  runId: string;
  messageId?: string;
  taskId?: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  createdAt: IsoDate;
  resolvedAt?: IsoDate;
};

export type AppState = {
  workspace: Workspace;
  providers: ProviderCredential[];
  employees: Employee[];
  skills: Skill[];
  groups: Group[];
  conversations: Conversation[];
  messages: Message[];
  runs: Run[];
  runEvents: RunEvent[];
  tasks: Task[];
  artifacts: Artifact[];
  approvals: Approval[];
};
