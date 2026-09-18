import type { ProviderId } from "@/lib/provider-catalog";

import type { ArtifactType } from "@/lib/artifact-types";

export type IsoDate = string;

export type DiscussionBudget = {
  maxTotalTokens?: number;
  softTotalTokens?: number;
  maxTotalCostMicros?: number;
  softTotalCostMicros?: number;
  currency?: string;
};

export type Workspace = {
  id: string;
  name: string;
  workerHeartbeatAt?: IsoDate;
  discussionBudgetDefaults?: DiscussionBudget;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type ProviderCredential = {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  label: string;
  encryptedCredential: string;
  lastValidatedAt?: IsoDate;
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
  fallbackTargets?: ModelTargetConfig[];
  skillIds: string[];
  active: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type ModelTargetConfig = {
  providerCredentialId: string;
  modelId: string;
};

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated" | "unknown";
};

export type ProviderAttemptPurpose =
  | "conversation"
  | "discussion_turn"
  | "discussion_synthesis"
  | "discussion_compression"
  | "smoke_test";

export type ProviderAttemptStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "ambiguous";

export const PROVIDER_FAILURE_KINDS = [
  "terminal",
  "retryable",
  "rate_limited",
  "timeout",
  "cancelled",
  "malformed_output",
  "unknown"
] as const;

export type ProviderFailureKind =
  (typeof PROVIDER_FAILURE_KINDS)[number];

export type ProviderAttempt = {
  id: string;
  workspaceId: string;
  runId?: string;
  discussionId?: string;
  roundId?: string;
  turnId?: string;
  purpose: ProviderAttemptPurpose;
  provider: ProviderId;
  modelId: string;
  targetOrder: number;
  attempt: number;
  status: ProviderAttemptStatus;
  requestId?: string;
  providerRequestId?: string;
  responseModel?: string;
  fallbackFromAttemptId?: string;
  errorKind?: ProviderFailureKind;
  errorCode?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  usage: ModelUsage;
  pricingId?: string;
  estimatedCostMicros?: number | null;
  startedAt: IsoDate;
  completedAt?: IsoDate;
};

export type EvidenceReferenceKind =
  | "message"
  | "turn"
  | "task"
  | "artifact"
  | "tool_result"
  | "external_source";

export type EvidenceReference = {
  id: string;
  workspaceId: string;
  kind: EvidenceReferenceKind;
  sourceId: string;
  locator?: string;
  excerptHash?: string;
  retrievedAt?: IsoDate;
  createdAt: IsoDate;
};

export type DiscussionInterventionKind =
  | "constraint"
  | "question"
  | "material"
  | "correction"
  | "focus"
  | "participant_change"
  | "mode_change"
  | "budget_change"
  | "extension"
  | "stop"
  | "cancel";

export type DiscussionIntervention = {
  id: string;
  workspaceId: string;
  discussionId: string;
  kind: DiscussionInterventionKind;
  content: string;
  status: "pending" | "applied" | "rejected" | "superseded";
  createdBy: string;
  idempotencyKey?: string;
  appliedPhase?: DiscussionRoundPhase;
  appliedRoundId?: string;
  resultingDiscussionRevision?: number;
  appliedAt?: IsoDate;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type DiscussionCompression = {
  id: string;
  workspaceId: string;
  discussionId: string;
  status: "pending" | "completed" | "failed";
  sourceRoundIds: string[];
  sourceTurnIds: string[];
  evidenceIds: string[];
  content: string;
  unresolvedQuestions: string[];
  minorityPositions: string[];
  schemaVersion: number;
  promptProfileVersion: string;
  compressionProfileVersion: string;
  contentHash: string;
  sourceSpanHash: string;
  strategy: "semantic" | "extractive";
  provider?: ProviderId;
  modelId?: string;
  createdByAttemptId?: string;
  previousCompressionId?: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type DiscussionContextRevision = {
  id: string;
  workspaceId: string;
  discussionId: string;
  roundId: string;
  turnId: string;
  contextWindow: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
  schemaOverheadTokens: number;
  toolOverheadTokens: number;
  inputTokens: number;
  outputReserveTokens: number;
  countSource: "exact" | "estimated" | "unknown";
  contextHash: string;
  roundIds: string[];
  turnIds: string[];
  messageIds: string[];
  compressionIds: string[];
  createdAt: IsoDate;
};

export type ModelPricing = {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  modelId: string;
  currency: string;
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens?: number;
  effectiveAt: IsoDate;
  source: string;
  version: string;
  createdAt: IsoDate;
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
  taskId?: string;
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
  taskId?: string;
  requestId?: string;
  discussionId?: string;
  discussionRound?: number;
  memberSnapshot: string[];
  status: RunStatus;
  error?: string;
  errorCode?: string;
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
    | "provider_attempt_started"
    | "provider_attempt_completed"
    | "provider_retry_scheduled"
    | "provider_fallback_started"
    | "provider_target_skipped"
    | "usage_recorded"
    | "evidence_validated"
    | "evidence_validation_failed"
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

export type TaskAction =
  | "start"
  | "stop"
  | "resume_run"
  | "block"
  | "resume"
  | "review"
  | "return_to_work"
  | "complete"
  | "cancel";

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
    runId?: string;
  }>;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type Artifact = {
  id: string;
  workspaceId: string;
  ownerType: "task" | "discussion";
  ownerId: string;
  runId?: string;
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

export type SourceKind = "url" | "file";

export type SourceStatus =
  | "pending"
  | "ingesting"
  | "ready"
  | "failed";

export type Source = {
  id: string;
  workspaceId: string;
  title: string;
  kind: SourceKind;
  location: string;
  status: SourceStatus;
  error?: string;
  contentHash?: string;
  chunkCount: number;
  /** Transient raw upload content retained only while ingestion is in flight. */
  pendingContent?: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
};

export type Chunk = {
  id: string;
  workspaceId: string;
  sourceId: string;
  index: number;
  content: string;
  contentHash: string;
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
    evidenceIds?: string[];
    kind?: "fact" | "inference" | "opinion" | "assumption";
    confidence: "low" | "medium" | "high";
  }>;
  assumptions: string[];
  risks: string[];
  openQuestions: string[];
  agreements?: string[];
  disagreements?: string[];
  corrections?: string[];
  convergence?: {
    recommended: boolean;
    reasons: string[];
  };
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
  "discussion_review_requested",
  "compression_applied",
  "compression_used",
  "intervention_queued",
  "intervention_applied",
  "context_budget_rejected",
  "provider_attempt_started",
  "provider_attempt_completed",
  "provider_retry_scheduled",
  "usage_recorded",
  "evidence_validated",
  "evidence_validation_failed",
  "provider_fallback_started",
  "provider_target_skipped"
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
  revision?: number;
  latestBriefArtifactId?: string;
  confirmedBriefArtifactId?: string;
  budget?: DiscussionBudget;
  constraints?: string[];
  questions?: string[];
  note?: string;
  sourceTaskId?: string;
  confirmedTaskId?: string;
  sourceIds: string[];
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
  sources: Source[];
  chunks: Chunk[];
  discussions: Discussion[];
  providerAttempts: ProviderAttempt[];
  evidenceReferences: EvidenceReference[];
  discussionCompressions: DiscussionCompression[];
  discussionInterventions: DiscussionIntervention[];
  discussionContextRevisions: DiscussionContextRevision[];
  modelPricing: ModelPricing[];
  approvals: Approval[];
  idempotencyRecords?: IdempotencyRecord[];
};
