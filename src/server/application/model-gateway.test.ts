import { describe, expect, it } from "vitest";
import { FakeModelGateway } from "@/server/adapters/model/model-gateway";
import type {
  ModelEvent,
  ModelRequest
} from "@/server/application/model-gateway";

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function request(
  input: Pick<
    ModelRequest,
    | "systemPrompt"
    | "prompt"
    | "messages"
    | "requestId"
    | "purpose"
    | "maxOutputTokens"
  >
): ModelRequest {
  return {
    provider: "openai",
    credential: "test-credential",
    modelId: "test-model",
    tools: [],
    ...input
  };
}

describe("ModelGateway request contracts", () => {
  it("uses structured message history while preserving the legacy prompt path", async () => {
    const gateway = new FakeModelGateway(0);

    const structured = await collect(
      gateway.run(
        request({
          systemPrompt: "You are Alice.",
          prompt: "Legacy request",
          requestId: "request-1",
          purpose: "discussion_turn",
          maxOutputTokens: 2_000,
          messages: [
            {
              id: "message-1",
              role: "user",
              content: "FAIL_MODEL",
              kind: "user_intervention",
              evidenceIds: ["evidence-1"]
            }
          ]
        })
      )
    );
    const legacy = await collect(
      gateway.run(
        request({
          systemPrompt: "You are Alice.",
          prompt: "FAIL_MODEL"
        })
      )
    );

    expect(structured).toContainEqual({
      type: "error",
      message: "model failed after partial output",
      kind: "terminal"
    });
    expect(legacy).toContainEqual({
      type: "error",
      message: "model failed after partial output",
      kind: "terminal"
    });
  });
});
