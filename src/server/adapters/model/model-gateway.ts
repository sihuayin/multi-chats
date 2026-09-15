import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool
} from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { createProviderModels } from "@/server/adapters/model/provider-registry";
import type {
  ModelEvent,
  ModelGateway,
  ModelMessage,
  ModelRequest
} from "@/server/application/model-gateway";
import { isToolExecutionErrorKind } from "@/server/application/tool-gateway";
import {
  classifyProviderFailure,
  retryAfterMsFromHeaders
} from "@/server/application/provider-reliability";

export class FakeModelGateway implements ModelGateway {
  constructor(
    private readonly delayMs = Number(process.env.MODEL_STREAM_DELAY_MS ?? 15)
  ) {}

  async *run(request: ModelRequest): AsyncIterable<ModelEvent> {
    const latestUserContent =
      [...(request.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content ??
      [...request.prompt.matchAll(/^User: (.+)$/gm)].at(-1)?.[1] ??
      request.prompt;
    if (latestUserContent.includes("FAIL_MODEL")) {
      yield { type: "text_delta", delta: "Partial failure output." };
      yield {
        type: "error",
        message: "model failed after partial output",
        kind: "terminal"
      };
      return;
    }
    if (latestUserContent.includes("USE_CURRENT_TIME")) {
      const tool = request.tools.find((item) => item.name === "current_time");
      if (!tool) {
        yield { type: "error", message: "current_time Tool is unavailable", kind: "terminal" };
        return;
      }
      yield {
        type: "tool_started",
        toolCallId: "fake-current-time",
        toolName: tool.name,
        args: {}
      };
      const result = await tool.execute("fake-current-time", {});
      yield {
        type: "tool_completed",
        toolCallId: "fake-current-time",
        toolName: tool.name,
        result: result.content,
        isError: Boolean(result.isError),
        errorKind: result.errorKind
      };
      const text = result.isError
        ? `Tool failed: ${result.content}`
        : `Current time: ${result.content}`;
      yield { type: "text_delta", delta: text };
      yield { type: "text_completed", text };
      return;
    }
    if (latestUserContent.includes("USE_POST_WEBHOOK")) {
      const tool = request.tools.find((item) => item.name === "post_webhook");
      if (!tool) {
        yield { type: "error", message: "post_webhook Tool is unavailable", kind: "terminal" };
        return;
      }
      const args = {
        url: "http://127.0.0.1:9/hook",
        body: { launch: true }
      };
      yield {
        type: "tool_started",
        toolCallId: "fake-post-webhook",
        toolName: tool.name,
        args
      };
      const result = await tool.execute(
        "fake-post-webhook",
        args,
        request.signal
      );
      yield {
        type: "tool_completed",
        toolCallId: "fake-post-webhook",
        toolName: tool.name,
        result: result.content,
        isError: Boolean(result.isError),
        errorKind: result.errorKind
      };
      const text = result.isError
        ? `Tool failed: ${result.content}`
        : `Tool completed: ${result.content}`;
      yield { type: "text_delta", delta: text };
      yield { type: "text_completed", text };
      return;
    }
    const employee = request.systemPrompt
      .split("\n")[0]
      .replace("You are ", "")
      .replace(/\.$/, "");
    if (request.systemPrompt.includes("Profile version: discussion-prompts.v2")) {
      const phase =
        request.systemPrompt.match(/^Phase: (\w+)\./m)?.[1] ??
        "positions";
      const discussionId =
        request.prompt.match(/^Discussion ID: (.+)$/m)?.[1] ??
        "fake-discussion";
      const mode =
        request.systemPrompt.match(/^Mode: (\w+)\./m)?.[1] ??
        "problem";
      const title =
        request.prompt.match(/^Discussion: (.+)$/m)?.[1] ??
        "Fake Discussion";
      const response =
        phase === "synthesis"
          ? {
              schemaVersion: 2,
              promptProfileVersion: "discussion-prompts.v2",
              discussionId,
              mode,
              title,
              problem: {
                statement: title,
                goals: ["Reach a decision"],
                nonGoals: []
              },
              context: "Deterministic fake Discussion context.",
              facts: [
                {
                  statement: "The Discussion has a deterministic fixture.",
                  kind: "fact",
                  evidenceIds: ["external:https://example.com/fixture"]
                }
              ],
              constraints: [],
              assumptions: [],
              disagreements: [],
              minorityPositions: [],
              options: [
                {
                  id: "recommended",
                  title: "Recommended option",
                  summary: "Proceed with the recommended option.",
                  benefits: ["Clear next step"],
                  costs: [],
                  risks: []
                }
              ],
              recommendation: {
                optionId: "recommended",
                rationale: "It is the deterministic test recommendation.",
                confidence: "high"
              },
              actions: [],
              openQuestions: []
            }
          : {
              summary: `${employee} ${phase} response`,
              claims: [
                {
                  statement: `${phase} produced a deterministic claim`,
                  kind: "inference",
                  evidenceIds: [],
                  confidence: "high"
                }
              ],
              assumptions: [],
              risks: [],
              openQuestions: [],
              ...(phase === "cross_response"
                ? {
                    agreements: [],
                    disagreements: [],
                    corrections: []
                  }
                : {})
            };
      const text = JSON.stringify(response);
      yield { type: "text_delta", delta: text };
      yield { type: "text_completed", text };
      return;
    }
    const text = `${employee} reviewed the request and prepared a structured response.`;
    for (const delta of text.match(/.{1,18}/g) ?? [text]) {
      if (request.signal?.aborted) throw new Error("aborted");
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (request.signal?.aborted) throw new Error("aborted");
      yield { type: "text_delta", delta };
    }
    yield { type: "text_completed", text };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class PiModelGateway implements ModelGateway {
  async *run(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal?.aborted) {
      yield {
        type: "error",
        message: "Request cancelled",
        kind: "cancelled",
        code: "provider_cancelled"
      };
      return;
    }

    const models = createProviderModels(request.provider, request.credential);
    const model = models.getModel(request.provider, request.modelId);
    if (!model) {
      yield {
        type: "error",
        message: `Model ${request.modelId} is not available`,
        kind: "terminal"
      };
      return;
    }

    const queue: ModelEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let finalText = "";
    let providerAttempt = 0;
    let finalAssistantMessage: AssistantMessage | undefined;
    let providerStatus: number | undefined;
    let providerRetryAfterMs: number | undefined;

    const push = (event: ModelEvent) => {
      queue.push(event);
      wake?.();
      wake = undefined;
    };

    const tools: AgentTool[] = request.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
      replay: tool.replay,
      execute: async (toolCallId, params, signal) => {
        const result = await tool.execute(toolCallId, asRecord(params), signal);
        return {
          content: [{ type: "text", text: result.content }],
          details: result.errorKind
            ? {
                ...asRecord(result.details),
                errorKind: result.errorKind
              }
            : result.details,
          isError: result.isError
        };
      }
    }));
    const promptMessages: AgentMessage[] | null = request.messages?.length
      ? request.messages.map((message: ModelMessage): AgentMessage => {
          if (message.role === "user") {
            return {
              role: "user",
              content: message.content,
              timestamp: Date.now()
            };
          }
          return {
            role: "assistant",
            content: [{ type: "text", text: message.content }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0
              }
            },
            stopReason: "stop",
            timestamp: Date.now()
          };
        })
      : null;

    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model,
        tools
      },
      streamFn: models.streamSimple.bind(models),
      onPayload: () => {
        providerAttempt += 1;
        push({
          type: "provider_attempt_started",
          attempt: providerAttempt
        });
        return undefined;
      },
      onResponse: (response) => {
        providerStatus = response.status;
        providerRetryAfterMs = retryAfterMsFromHeaders(
          response.headers
        );
      },
      toolExecution: "sequential",
      afterToolCall: async ({ result, isError }) => ({
        isError:
          isError || isToolExecutionErrorKind(asRecord(result.details).errorKind)
      }),
      maxRetryDelayMs: 2_000
    });

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          finalText += update.delta;
          push({ type: "text_delta", delta: update.delta });
        }
        if (update.type === "error") {
          const message = update.error.errorMessage ?? "Model request failed";
          const failure = classifyProviderFailure({
            message,
            status: providerStatus,
            retryAfterMs: providerRetryAfterMs
          });
          push({
            type: "error",
            message,
            kind: failure.kind,
            code: failure.code,
            ambiguous: failure.ambiguous,
            retryAfterMs: failure.retryAfterMs,
            status: failure.status
          });
        }
      }

      if (event.type === "tool_execution_start") {
        push({
          type: "tool_started",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: asRecord(event.args)
        });
      }

      if (event.type === "tool_execution_end") {
        const details = asRecord(event.result?.details);
        const text =
          Array.isArray(event.result?.content) &&
          event.result.content.every((item: unknown) => typeof item === "object")
            ? event.result.content
                .map((item: { type?: string; text?: string }) =>
                  item.type === "text" ? item.text ?? "" : ""
                )
                .join("\n")
            : "";
        push({
          type: "tool_completed",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: text,
          isError: event.isError,
          errorKind: isToolExecutionErrorKind(details.errorKind)
            ? details.errorKind
            : undefined
        });
      }

      if (
        event.type === "message_end" &&
        event.message.role === "assistant"
      ) {
        finalAssistantMessage = event.message;
        const usage = event.message.usage;
        push({
          type: "usage",
          usage: {
            inputTokens: usage.input,
            outputTokens: usage.output,
            cachedInputTokens: usage.cacheRead,
            cacheWriteTokens: usage.cacheWrite,
            cacheWrite1hTokens: usage.cacheWrite1h,
            reasoningTokens: usage.reasoning,
            totalTokens: usage.totalTokens,
            source: "provider"
          },
          providerRequestId: event.message.responseId,
          responseModel:
            event.message.responseModel ?? event.message.model
        });
      }

      if (event.type === "agent_end") {
        finished = true;
        if (
          finalAssistantMessage?.stopReason === "error" ||
          finalAssistantMessage?.stopReason === "aborted"
        ) {
          const message =
            finalAssistantMessage.errorMessage ?? "Model request failed";
          const failure = classifyProviderFailure({
            message,
            kind:
              finalAssistantMessage.stopReason === "aborted"
                ? "cancelled"
                : undefined,
            status: providerStatus,
            retryAfterMs: providerRetryAfterMs
          });
          push({
            type: "error",
            message,
            kind: failure.kind,
            code: failure.code,
            ambiguous: failure.ambiguous,
            retryAfterMs: failure.retryAfterMs,
            status: failure.status
          });
        } else {
          push({ type: "text_completed", text: finalText });
        }
        wake?.();
        wake = undefined;
      }
    });
    const abortAgent = () => agent.abort();
    request.signal?.addEventListener("abort", abortAgent, { once: true });
    if (request.signal?.aborted) agent.abort();

    const runPromise = (
      promptMessages
        ? agent.prompt(promptMessages)
        : agent.prompt(request.prompt)
    )
      .catch((error: unknown) => {
        const failure = classifyProviderFailure({
          message: error instanceof Error ? error.message : String(error),
          kind: request.signal?.aborted ? "cancelled" : undefined,
          status: providerStatus,
          retryAfterMs: providerRetryAfterMs
        });
        push({
          type: "error",
          message: failure.message,
          kind: failure.kind,
          code: failure.code,
          ambiguous: failure.ambiguous,
          retryAfterMs: failure.retryAfterMs,
          status: failure.status
        });
        finished = true;
        wake?.();
        wake = undefined;
      });

    try {
      while (!finished || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        while (queue.length > 0) {
          yield queue.shift() as ModelEvent;
        }
      }
      await runPromise;
    } finally {
      request.signal?.removeEventListener("abort", abortAgent);
      unsubscribe();
    }
  }
}

export function createModelGateway(): ModelGateway {
  return process.env.MODEL_MODE === "fake"
    ? new FakeModelGateway()
    : new PiModelGateway();
}
