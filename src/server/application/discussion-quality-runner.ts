import { parseDiscussionBrief } from "@/server/application/discussion-brief";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import type { ModelContext } from "@/server/application/discussion-context";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import type { ModelGateway } from "@/server/application/model-gateway";
import {
  DISCUSSION_QUALITY_CORPUS,
  DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT,
  evaluateDiscussionQuality,
  type DiscussionQualityReport,
  type DiscussionQualityResult
} from "@/server/application/discussion-quality";
import type {
  ProviderSmokeRunConfig
} from "@/server/application/provider-smoke";
import { sumModelUsage } from "@/server/application/provider-smoke";
import type { CredentialCipher } from "@/server/security/credential-cipher";
import { createInitialState } from "@/server/store/initial-state";
import { MemoryStore } from "@/server/store/memory-store";
import type {
  DiscussionMode,
  DiscussionRole,
  IsoDate,
  ModelPricing,
  ProviderId
} from "@/server/domain/types";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const PROVIDER_ID = "quality-provider";

const PARTICIPANTS: Array<{
  id: string;
  name: string;
  role: DiscussionRole;
  objective: string;
}> = [
  {
    id: "quality-analyst",
    name: "Quality Analyst",
    role: "analyst",
    objective: "Define the problem boundary and decision criteria."
  },
  {
    id: "quality-researcher",
    name: "Quality Researcher",
    role: "researcher",
    objective: "Ground claims in verifiable evidence."
  },
  {
    id: "quality-skeptic",
    name: "Quality Skeptic",
    role: "skeptic",
    objective: "Challenge assumptions and preserve uncertainty."
  },
  {
    id: "quality-designer",
    name: "Quality Designer",
    role: "designer",
    objective: "Produce actionable options and implementation choices."
  },
  {
    id: "quality-facilitator",
    name: "Quality Facilitator",
    role: "facilitator",
    objective: "Synthesize the Brief without erasing disagreement."
  }
];

export type DiscussionQualityRunnerDependencies = {
  gateway: ModelGateway;
  cipher: CredentialCipher;
  modelContext: (input: {
    provider: ProviderId;
    modelId: string;
  }) => ModelContext;
  clock?: () => IsoDate;
};

async function seedWorkspace(input: {
  store: MemoryStore;
  cipher: CredentialCipher;
  config: ProviderSmokeRunConfig;
  clock: () => IsoDate;
}): Promise<void> {
  const { store, cipher, config, clock } = input;
  const primary = config.targets[0];
  const timestamp = clock();
  await store.update((state) => {
    state.providers.push({
      id: PROVIDER_ID,
      workspaceId: state.workspace.id,
      provider: primary.provider,
      label: `Quality primary (${primary.provider})`,
      encryptedCredential: cipher.encrypt(primary.credential),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    for (const participant of PARTICIPANTS) {
      state.employees.push({
        id: participant.id,
        workspaceId: state.workspace.id,
        name: participant.name,
        identity: `You are the ${participant.role} in a bounded Discussion.`,
        providerCredentialId: PROVIDER_ID,
        modelId: primary.modelId,
        skillIds: [],
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
    const pricing: ModelPricing = {
      id: "quality-pricing",
      workspaceId: state.workspace.id,
      provider: primary.provider,
      modelId: primary.modelId,
      currency: "USD",
      inputMicrosPerMillionTokens:
        config.pricing.inputMicrosPerMillionTokens,
      outputMicrosPerMillionTokens:
        config.pricing.outputMicrosPerMillionTokens,
      effectiveAt: timestamp,
      source: "discussion_quality",
      version: "quality-default",
      createdAt: timestamp
    };
    state.modelPricing.push(pricing);
  });
}

async function queuedRunId(
  store: MemoryStore,
  discussionId: string
): Promise<string | undefined> {
  return store.read(
    (state) =>
      state.runs.find(
        (run) =>
          run.discussionId === discussionId && run.status === "queued"
      )?.id
  );
}

function qualityTitle(mode: DiscussionMode, repeat: number): string {
  return `Discussion quality ${mode} run ${repeat + 1}`;
}

async function runDiscussionToTerminalState(input: {
  store: MemoryStore;
  runs: ConversationRunService;
  orchestrator: DiscussionOrchestrator;
  discussionId: string;
}): Promise<void> {
  const { store, runs, orchestrator, discussionId } = input;
  for (let step = 0; step < 10; step += 1) {
    const runId = await queuedRunId(store, discussionId);
    if (runId) {
      const run = await runs.processRun(runId);
      await orchestrator.advanceDiscussion(discussionId);
      if (run.status !== "completed") return;
      continue;
    }

    const status = await store.read(
      (state) =>
        state.discussions.find((item) => item.id === discussionId)?.status
    );
    if (status !== "running") return;
    await orchestrator.advanceDiscussion(discussionId);
  }
  throw new Error(`Quality Discussion ${discussionId} did not reach a terminal state`);
}

function assertWithinCaps(
  store: MemoryStore,
  config: ProviderSmokeRunConfig
): void {
  const snapshot = store.snapshot();
  const attempts = snapshot.providerAttempts;
  const usage = sumModelUsage(attempts.map((attempt) => attempt.usage));
  const cost = attempts.reduce(
    (total, attempt) => total + (attempt.estimatedCostMicros ?? 0),
    0
  );
  if (
    (usage.totalTokens ?? 0) >= config.limits.maxTotalTokens ||
    cost >= config.limits.maxCostMicros
  ) {
    throw new Error(
      "Discussion quality corpus reached its token or cost cap."
    );
  }
}

export async function runDiscussionQualityCorpusAgainstProviders(
  config: ProviderSmokeRunConfig,
  dependencies: DiscussionQualityRunnerDependencies
): Promise<DiscussionQualityReport> {
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const store = new MemoryStore(createInitialState(WORKSPACE_ID));
  await seedWorkspace({
    store,
    cipher: dependencies.cipher,
    config,
    clock
  });
  const runs = new ConversationRunService(
    store,
    dependencies.cipher,
    dependencies.gateway,
    {
      modelContext: (input) => {
        const context = dependencies.modelContext(input);
        return {
          ...context,
          maxOutputTokens: Math.min(context.maxOutputTokens ?? 800, 800)
        };
      },
      providerTimeoutMs: config.limits.timeoutMs
    }
  );
  const orchestrator = new DiscussionOrchestrator(store, runs);
  const deterministicRuns: DiscussionQualityResult[][] = [];
  let conversationCount = 0;

  for (
    let repeat = 0;
    repeat < DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT;
    repeat += 1
  ) {
    const results: DiscussionQualityResult[] = [];
    for (const scenario of DISCUSSION_QUALITY_CORPUS) {
      assertWithinCaps(store, config);
      conversationCount += 1;
      const conversationId = `quality-conversation-${conversationCount}`;
      await store.update((state) => {
        state.conversations.push({
          id: conversationId,
          workspaceId: state.workspace.id,
          title: `Quality conversation ${conversationCount}`,
          memberIds: PARTICIPANTS.map((participant) => participant.id),
          createdAt: clock(),
          updatedAt: clock()
        });
      });
      const view = await orchestrator.createDiscussion(conversationId, {
        title: qualityTitle(scenario.mode, repeat),
        mode: scenario.mode,
        language: "en",
        maxRounds: 3,
        participants: PARTICIPANTS.map((participant) => ({
          employeeId: participant.id,
          role: participant.role,
          objective: participant.objective
        })),
        facilitatorId: "quality-facilitator"
      });
      if (scenario.expected.requiredSignal === "constraints") {
        await store.update((state) => {
          const discussion = state.discussions.find(
            (item) => item.id === view.discussion.id
          )!;
          discussion.constraints = [
            "Preserve release safety, rollback, and verification requirements."
          ];
        });
      }

      await orchestrator.startDiscussion(view.discussion.id);
      await runDiscussionToTerminalState({
        store,
        runs,
        orchestrator,
        discussionId: view.discussion.id
      });

      const snapshot = store.snapshot();
      const discussion = snapshot.discussions.find(
        (item) => item.id === view.discussion.id
      )!;
      const artifact = discussion.latestBriefArtifactId
        ? snapshot.artifacts.find(
            (item) => item.id === discussion.latestBriefArtifactId
          )
        : undefined;
      results.push(
        evaluateDiscussionQuality({
          scenarioId: scenario.id,
          state: snapshot,
          discussion,
          ...(artifact
            ? { brief: parseDiscussionBrief(artifact.content) }
            : {})
        })
      );
    }
    deterministicRuns.push(results);
  }

  return {
    deterministicRuns,
    evidenceLinks: [
      config.evidenceLink ?? "artifact://discussion-quality/local"
    ]
  };
}
