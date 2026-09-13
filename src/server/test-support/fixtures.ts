import type {
  ModelGateway,
  ModelRequest,
  ModelTool
} from "@/server/application/model-gateway";
import type { ProviderRegistry } from "@/server/application/provider-gateway";
import type {
  AppState,
  Discussion,
  DiscussionRoundPhase,
  DiscussionTurnPayload,
  Employee
} from "@/server/domain/types";
import type { DiscussionBrief } from "@/server/application/discussion-brief";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { createInitialState } from "@/server/store/initial-state";

export const TEST_KEY = "test-encryption-key";

export const noopProviderRegistry: ProviderRegistry = {
  async validate() {},
  async listModels() {
    return [];
  }
};

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

export function createFixtureDiscussion(
  options: {
    id?: string;
    workspaceId?: string;
    conversationId?: string;
  } = {}
): Discussion {
  const now = "2026-01-01T00:00:00.000Z";
  const id = options.id ?? "70000000-0000-4000-8000-000000000001";
  const workspaceId =
    options.workspaceId ?? "00000000-0000-4000-8000-000000000001";
  const conversationId =
    options.conversationId ?? "30000000-0000-4000-8000-000000000001";
  const participants: Discussion["participants"] = [
    {
      id: "participant-analyst",
      employeeId: "20000000-0000-4000-8000-000000000001",
      role: "analyst",
      objective: "Define the problem boundary.",
      order: 1
    },
    {
      id: "participant-facilitator",
      employeeId: "20000000-0000-4000-8000-000000000002",
      role: "facilitator",
      objective: "Synthesize the recommendation.",
      order: 2
    }
  ];

  return {
    id,
    workspaceId,
    conversationId,
    title: "Choose a persistence model",
    mode: "solution",
    language: "en",
    promptProfileVersion: "discussion-prompts.v1",
    status: "review",
    facilitatorParticipantId: participants[1].id,
    maxRounds: 3,
    currentRound: 1,
    participants,
    events: [],
    rounds: [
      {
        id: `${id}-round-1`,
        roundNumber: 1,
        phase: "positions",
        status: "completed",
        runId: `${id}-run-1`,
        participantSnapshot: structuredClone(participants),
        activeParticipantIds: participants.map((participant) => participant.id),
        turns: participants.map((participant, index) => ({
          id: `${id}-turn-${index + 1}`,
          employeeId: participant.employeeId,
          role: participant.role,
          order: participant.order,
          status: "completed",
          messageId: `${id}-message-${index + 1}`,
          payload: {
            summary: `${participant.role} position`,
            claims: [
              {
                statement: "Use the existing state document.",
                confidence: "high"
              }
            ],
            assumptions: [],
            risks: [],
            openQuestions: []
          },
          createdAt: now,
          startedAt: now,
          completedAt: now
        })),
        createdAt: now,
        startedAt: now,
        completedAt: now
      }
    ],
    createdAt: now,
    startedAt: now,
    updatedAt: now
  };
}

export function createFixtureTurnPayload(
  phase: DiscussionRoundPhase = "positions",
  summary = "Fixture position"
): DiscussionTurnPayload {
  return {
    summary,
    claims: [
      {
        statement: summary,
        confidence: "medium"
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
}

export function createFixtureBrief(
  discussionId = "70000000-0000-4000-8000-000000000001"
): DiscussionBrief {
  return {
    schemaVersion: 1,
    promptProfileVersion: "discussion-prompts.v1",
    discussionId,
    mode: "solution",
    title: "Choose a persistence model",
    problem: {
      statement: "Discussions need durable state.",
      goals: ["Preserve history"],
      nonGoals: []
    },
    context: "The workspace stores its state as JSON.",
    facts: [
      {
        statement: "SQLite and PostgreSQL are supported.",
        evidence: "Store tests"
      }
    ],
    constraints: [],
    assumptions: [],
    disagreements: [],
    options: [
      {
        id: "state-document",
        title: "Keep the state document",
        summary: "Continue using the shared JSON aggregate.",
        benefits: ["Reuses tested storage"],
        costs: [],
        risks: []
      }
    ],
    recommendation: {
      optionId: "state-document",
      rationale: "It has the smallest migration surface.",
      confidence: "high"
    },
    actions: [],
    openQuestions: []
  };
}

export function discussionModelGateway(): RecordingModelGateway {
  return new RecordingModelGateway((request) => {
    const phase = request.systemPrompt.includes("Phase: synthesis")
      ? "synthesis"
      : request.systemPrompt.includes("Phase: cross_response")
        ? "cross_response"
        : "positions";
    const response =
      phase === "synthesis"
        ? createFixtureBrief(
            request.prompt.match(/Discussion ID: ([^\n]+)/)?.[1]
          )
        : createFixtureTurnPayload(phase);
    const text = JSON.stringify(response);
    return [text];
  });
}

export class RecordingModelGateway implements ModelGateway {
  readonly requests: Array<
    Omit<ModelRequest, "tools"> & {
      tools: Array<Omit<ModelTool, "execute">>;
    }
  > = [];

  constructor(
    private readonly respond: (request: ModelRequest) => string[] = (request) => [
      `${request.systemPrompt.split("\n")[0]} response`
    ]
  ) {}

  async *run(request: ModelRequest) {
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

export class ToolCallingModelGateway implements ModelGateway {
  async *run(request: ModelRequest) {
    const tool = request.tools.find((item) => item.name === "post_webhook");
    if (!tool) throw new Error("Test Model Gateway expected post_webhook");
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
      isError: Boolean(result.isError),
      errorKind: result.errorKind
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
