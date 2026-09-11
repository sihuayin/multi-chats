import type { ProviderId } from "@/server/domain/types";

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
  ) => Promise<{ content: string; details?: unknown; isError?: boolean }>;
};

export type ModelRequest = {
  provider: ProviderId;
  credential: string;
  modelId: string;
  systemPrompt: string;
  prompt: string;
  tools: ModelTool[];
  signal?: AbortSignal;
};

export type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "text_completed"; text: string }
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
    }
  | { type: "error"; message: string };

export interface ModelGateway {
  run(request: ModelRequest): AsyncIterable<ModelEvent>;
}
