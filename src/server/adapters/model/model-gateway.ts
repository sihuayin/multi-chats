import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createProviderModels } from "@/server/adapters/model/provider-registry";
import type {
  ModelEvent,
  ModelGateway,
  ModelRequest
} from "@/server/application/model-gateway";

export class FakeModelGateway implements ModelGateway {
  constructor(
    private readonly delayMs = Number(process.env.MODEL_STREAM_DELAY_MS ?? 15)
  ) {}

  async *run(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.prompt.includes("FAIL_MODEL")) {
      yield { type: "text_delta", delta: "Partial failure output." };
      yield { type: "error", message: "model failed after partial output" };
      return;
    }
    const employee = request.systemPrompt
      .split("\n")[0]
      .replace("You are ", "")
      .replace(/\.$/, "");
    const text = `${employee} reviewed the request and prepared a structured response.`;
    for (const delta of text.match(/.{1,18}/g) ?? [text]) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
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
    const models = createProviderModels(request.provider, request.credential);
    const model = models.getModel(request.provider, request.modelId);
    if (!model) {
      yield { type: "error", message: `Model ${request.modelId} is not available` };
      return;
    }

    const queue: ModelEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let finalText = "";

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
          details: result.details,
          isError: result.isError
        };
      }
    }));

    const agent = new Agent({
      initialState: {
        systemPrompt: request.systemPrompt,
        model,
        tools
      },
      streamFn: models.streamSimple.bind(models),
      toolExecution: "sequential",
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
          push({ type: "error", message });
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
          isError: event.isError
        });
      }

      if (event.type === "agent_end") {
        finished = true;
        push({ type: "text_completed", text: finalText });
        wake?.();
        wake = undefined;
      }
    });
    const abortAgent = () => agent.abort();
    request.signal?.addEventListener("abort", abortAgent, { once: true });
    if (request.signal?.aborted) agent.abort();

    const runPromise = agent.prompt(request.prompt).catch((error: unknown) => {
      push({
        type: "error",
        message: error instanceof Error ? error.message : String(error)
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
