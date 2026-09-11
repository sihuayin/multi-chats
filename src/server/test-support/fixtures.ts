import type {
  AgentEngine,
  EngineRequest,
  EngineTool
} from "@/server/application/agent-engine";
import type { AppState, Employee } from "@/server/domain/types";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { createInitialState } from "@/server/store/initial-state";

export const TEST_KEY = "test-encryption-key";

export function createFixtureState(): AppState {
  const state = createInitialState("00000000-0000-4000-8000-000000000001");
  const cipher = new AesCredentialCipher(TEST_KEY);
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const providerId = "10000000-0000-4000-8000-000000000001";
  const researcherSkill = state.skills.find((skill) => skill.name === "Researcher");
  const writerSkill = state.skills.find((skill) => skill.name === "Writer");
  if (!researcherSkill || !writerSkill) throw new Error("Fixture skills missing");

  state.providers.push({
    id: providerId,
    workspaceId: state.workspace.id,
    provider: "openai",
    label: "Test provider",
    encryptedCredential: cipher.encrypt("test-api-key"),
    createdAt: now,
    updatedAt: now
  });

  const alice: Employee = {
    id: "20000000-0000-4000-8000-000000000001",
    workspaceId: state.workspace.id,
    name: "Alice",
    identity: "You are a careful researcher.",
    providerCredentialId: providerId,
    modelId: "test-model",
    skillIds: [researcherSkill.id],
    active: true,
    createdAt: now,
    updatedAt: now
  };
  const bob: Employee = {
    id: "20000000-0000-4000-8000-000000000002",
    workspaceId: state.workspace.id,
    name: "Bob",
    identity: "You are a concise writer.",
    providerCredentialId: providerId,
    modelId: "test-model",
    skillIds: [writerSkill.id],
    active: true,
    createdAt: now,
    updatedAt: now
  };
  state.employees.push(alice, bob);
  state.conversations.push({
    id: "30000000-0000-4000-8000-000000000001",
    workspaceId: state.workspace.id,
    title: "Launch planning",
    memberIds: [alice.id, bob.id],
    createdAt: now,
    updatedAt: now
  });
  return state;
}

export class RecordingEngine implements AgentEngine {
  readonly requests: Array<
    Omit<EngineRequest, "tools"> & {
      tools: Array<Omit<EngineTool, "execute">>;
    }
  > = [];

  constructor(
    private readonly respond: (request: EngineRequest) => string[] = (request) => [
      `${request.systemPrompt.split("\n")[0]} response`
    ]
  ) {}

  async *run(request: EngineRequest) {
    this.requests.push({
      ...request,
      tools: request.tools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        inputSchema: tool.inputSchema,
        replay: tool.replay
      }))
    });
    for (const delta of this.respond(request)) {
      yield { type: "text_delta" as const, delta };
    }
    const text = this.respond(request).join("");
    yield { type: "text_completed" as const, text };
  }
}

export class ToolCallingEngine implements AgentEngine {
  async *run(request: EngineRequest) {
    const tool = request.tools.find((item) => item.name === "post_webhook");
    if (!tool) throw new Error("Test engine expected post_webhook");
    yield {
      type: "tool_started" as const,
      toolCallId: "test-tool-call",
      toolName: tool.name,
      args: { url: "http://127.0.0.1:9/hook", body: { launch: true } }
    };
    const result = await tool.execute(
      "test-tool-call",
      { url: "http://127.0.0.1:9/hook", body: { launch: true } }
    );
    yield {
      type: "tool_completed" as const,
      toolCallId: "test-tool-call",
      toolName: tool.name,
      result: result.content,
      isError: Boolean(result.isError)
    };
    yield {
      type: "text_delta" as const,
      delta: result.isError ? "The Tool was not approved." : "Done."
    };
    yield {
      type: "text_completed" as const,
      text: result.isError ? "The Tool was not approved." : "Done."
    };
  }
}
