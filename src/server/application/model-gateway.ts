import type {
  DiscussionRoundPhase,
  ModelUsage,
  ProviderAttemptPurpose,
  ProviderFailureKind,
  ProviderId
} from "@/server/domain/types";
import type {
  ToolExecutionErrorKind,
  ToolExecutionResult
} from "@/server/application/tool-gateway";
export type ModelTool = {
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  replay: "never" | "safe";
  execute: (
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<ToolExecutionResult>;
};

export type ModelMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  kind?:
    | "conversation"
    | "user_intervention"
    | "discussion_turn"
    | "task_context"
    | "artifact_context";
  authorId?: string;
  employeeId?: string;
  discussionId?: string;
  roundId?: string;
  turnId?: string;
  participantId?: string;
  phase?: DiscussionRoundPhase;
  interventionId?: string;
  taskId?: string;
  artifactId?: string;
  evidenceIds?: string[];
};

export type ModelRequest = {
  provider: ProviderId;
  credential: string;
  modelId: string;
  requestId?: string;
  purpose?: ProviderAttemptPurpose;
  maxOutputTokens?: number;
  systemPrompt: string;
  prompt: string;
  messages?: ModelMessage[];
  tools: ModelTool[];
  signal?: AbortSignal;
};

export type ModelEvent =
  | { type: "provider_attempt_started"; attempt: number }
  | { type: "text_delta"; delta: string }
  | { type: "text_completed"; text: string }
  | {
      type: "usage";
      usage: ModelUsage;
      providerRequestId?: string;
      responseModel?: string;
    }
  | {
      type: "tool_started";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_completed";
      toolCallId: string;
      toolName: string;
      result: string;
      isError: boolean;
      errorKind?: ToolExecutionErrorKind;
    }
  | {
      type: "error";
      message: string;
      kind?: ProviderFailureKind;
      code?: string;
      ambiguous?: boolean;
      retryAfterMs?: number;
      status?: number;
    };

export interface ModelGateway {
  run(request: ModelRequest): AsyncIterable<ModelEvent>;
}
