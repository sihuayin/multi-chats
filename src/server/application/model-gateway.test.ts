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

  it("cites an ingested Source chunk in Discussion positions and synthesis", async () => {
    const gateway = new FakeModelGateway(0);
    const systemPrompt = [
      "You are Alice.",
      "Profile version: discussion-prompts.v5",
      "Mode: solution.",
      "Phase: positions."
    ].join("\n");

    const positions = await collect(
      gateway.run(
        request({
          systemPrompt,
          prompt: "Discussion: Grounded\n\nDiscussion ID: d-1",
          messages: [
            {
              id: "source-chunk-chunk-1",
              role: "user",
              content: "Source \"notes.md\" chunk:\nThe stored passage.",
              kind: "source_context",
              chunkId: "chunk-1"
            }
          ]
        })
      )
    );
    const positionText = positions.find(
      (event) => event.type === "text_completed"
    );
    expect(positionText).toBeDefined();
    const positionPayload = JSON.parse(
      (positionText as { text: string }).text
    ) as { claims: Array<{ kind: string; evidenceIds: string[] }> };
    expect(positionPayload.claims[0]).toMatchObject({
      kind: "fact",
      evidenceIds: ["external:chunk-1"]
    });

    const synthesis = await collect(
      gateway.run(
        request({
          systemPrompt: systemPrompt.replace("positions", "synthesis"),
          prompt: "Discussion: Grounded\n\nDiscussion ID: d-1",
          messages: [
            {
              id: "source-chunk-chunk-1",
              role: "user",
              content: "Source \"notes.md\" chunk:\nThe stored passage.",
              kind: "source_context",
              chunkId: "chunk-1"
            }
          ]
        })
      )
    );
    const synthesisText = synthesis.find(
      (event) => event.type === "text_completed"
    );
    const brief = JSON.parse(
      (synthesisText as { text: string }).text
    ) as { facts: Array<{ evidenceIds: string[] }> };
    expect(brief.facts[0].evidenceIds).toEqual(["external:chunk-1"]);
  });
});
