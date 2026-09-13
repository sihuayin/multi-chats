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
  discussionId?: string;
  discussionTurnId?: string;
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
  requestId?: string;
  discussionId?: string;
  discussionRound?: number;
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
    | "employee_turn_partial"
    | "employee_turn_cancelled"
    | "employee_turn_interrupted"
    | "skill_loaded"
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
  discussionId?: string;
  confirmedBriefArtifactId?: string;
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
  ownerType: "task" | "discussion";
  ownerId: string;
  type: ArtifactType;
  name: string;
  content: string;
  kind?: "discussion_brief";
  schemaVersion?: number;
  revision?: number;
  previousArtifactId?: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type DiscussionMode =
  | "requirements"
  | "problem"
  | "solution"
  | "review";

export type DiscussionRole =
  | "analyst"
  | "researcher"
  | "skeptic"
  | "designer"
  | "facilitator";

export type DiscussionStatus =
  | "draft"
  | "running"
  | "review"
  | "interrupted"
  | "completed"
  | "cancelled";

export type DiscussionRoundPhase =
  | "positions"
  | "cross_response"
  | "synthesis";

export type DiscussionRoundStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type DiscussionTurnStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type DiscussionParticipant = {
  id: string;
  employeeId: string;
  role: DiscussionRole;
  objective: string;
  order: number;
};

export type DiscussionTurnPayload = {
  summary: string;
  claims: Array<{
    statement: string;
    evidence?: string;
    confidence: "low" | "medium" | "high";
  }>;
  assumptions: string[];
  risks: string[];
  openQuestions: string[];
  agreements?: string[];
  disagreements?: string[];
  corrections?: string[];
};

export type DiscussionTurn = {
  id: string;
  employeeId: string;
  role: DiscussionRole;
  order: number;
  attempt?: number;
  status: DiscussionTurnStatus;
  messageId?: string;
  content?: string;
  payload?: DiscussionTurnPayload;
  validationError?: string;
  cancelReason?: string;
  createdAt: IsoDate;
  startedAt?: IsoDate;
  completedAt?: IsoDate;
};

export type DiscussionRound = {
  id: string;
  roundNumber: number;
  phase: DiscussionRoundPhase;
  status: DiscussionRoundStatus;
  runId?: string;
  participantSnapshot: DiscussionParticipant[];
  activeParticipantIds?: string[];
  turns: DiscussionTurn[];
  createdAt: IsoDate;
  startedAt?: IsoDate;
  completedAt?: IsoDate;
};

export const DISCUSSION_EVENT_TYPES = [
  "discussion_started",
  "phase_started",
  "phase_completed",
  "phase_failed",
  "brief_created",
  "discussion_confirmed",
  "discussion_interrupted",
  "discussion_resumed",
  "discussion_stopped",
  "discussion_cancelled",
  "discussion_converged",
  "discussion_budget_exhausted",
  "participant_skipped",
  "facilitator_replaced",
  "constraints_updated",
  "discussion_review_requested"
] as const;

export type DiscussionEventType = (typeof DISCUSSION_EVENT_TYPES)[number];

export type DiscussionEvent = {
  id: string;
  workspaceId: string;
  discussionId: string;
  sequence: number;
  type: DiscussionEventType;
  payload: Record<string, unknown>;
  createdAt: IsoDate;
};

export type Discussion = {
  id: string;
  workspaceId: string;
  conversationId: string;
  title: string;
  mode: DiscussionMode;
  language: "en" | "zh";
  promptProfileVersion?: string;
  status: DiscussionStatus;
  facilitatorParticipantId: string;
  maxRounds: number;
  currentRound: number;
  latestBriefArtifactId?: string;
  confirmedBriefArtifactId?: string;
  constraints?: string[];
  questions?: string[];
  note?: string;
  sourceTaskId?: string;
  confirmedTaskId?: string;
  participants: DiscussionParticipant[];
  rounds: DiscussionRound[];
  events?: DiscussionEvent[];
  createdAt: IsoDate;
  startedAt?: IsoDate;
  completedAt?: IsoDate;
  updatedAt: IsoDate;
};

export type Approval = {
  id: string;
  workspaceId: string;
  runId: string;
  messageId?: string;
  taskId?: string;
  employeeId?: string;
  toolCallId?: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  createdAt: IsoDate;
  expiresAt?: IsoDate;
  resolvedAt?: IsoDate;
};

export type ApprovalDecision = "approved" | "rejected" | "cancelled";

export type IdempotencyRecord = {
  id: string;
  scope: string;
  key: string;
  status: number;
  body: unknown;
  createdAt: IsoDate;
  expiresAt: IsoDate;
};

export type AppState = {
  schemaVersion: number;
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
  discussions: Discussion[];
  approvals: Approval[];
  idempotencyRecords?: IdempotencyRecord[];
};
