import { parseDiscussionBrief } from "@/server/application/discussion-brief";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import type { ModelContext } from "@/server/application/discussion-context";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import type {
  ModelEvent,
  ModelGateway,
  ModelRequest
} from "@/server/application/model-gateway";
import {
  assertProviderSmokeReportOmitsCredentials,
  runProviderSmokeMatrix,
  validateProviderSmokeReport,
  type ProviderSmokeAttemptRecord,
  type ProviderSmokeReport,
  type ProviderSmokeRunConfig,
  type ProviderSmokeScenario,
  type ProviderSmokeScenarioOutcome,
  type ProviderSmokeTarget
} from "@/server/application/provider-smoke";
import type { CredentialCipher } from "@/server/security/credential-cipher";
import { createInitialState } from "@/server/store/initial-state";
import { MemoryStore } from "@/server/store/memory-store";
import type {
  IsoDate,
  ModelPricing,
  ProviderAttempt,
  ProviderFailureKind,
  ProviderId
} from "@/server/domain/types";

const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ANALYST_EMPLOYEE_ID = "smoke-employee-analyst";
const FACILITATOR_EMPLOYEE_ID = "smoke-employee-facilitator";
/** Injected failures keep the retry, failover, and cancellation paths deterministic. */
const INJECTED_FAILURE_CODE = "provider_smoke_fault_injected";
const STALL_SAFETY_TIMEOUT_MS = 30_000;
/** Context window small enough to force a Discussion Compression under pressure. */
const PRESSURED_CONTEXT_WINDOW = 8_000;

export type ProviderSmokeFaultPlan = {
  retryableFailures: Map<string, { count: number; kind: ProviderFailureKind }>;
  stalls: Map<string, number>;
};

export function createProviderSmokeFaultPlan(): ProviderSmokeFaultPlan {
  return { retryableFailures: new Map(), stalls: new Map() };
}

function targetKey(provider: ProviderId, modelId: string): string {
  return `${provider}:${modelId}`;
}

async function* stallUntilAborted(
  signal: AbortSignal | undefined
): AsyncIterable<ModelEvent> {
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, STALL_SAFETY_TIMEOUT_MS);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
  yield {
    type: "error",
    kind: "cancelled",
    code: "provider_cancelled",
    message: "Provider smoke matrix cancelled the stalled request"
  };
}

/**
 * Wrap a Provider gateway so the smoke matrix can inject a retryable
 * failure or a stalled call deterministically, without weakening the
 * contracts the real adapters are proving.
 */
export function injectProviderSmokeFaults(
  gateway: ModelGateway,
  plan: ProviderSmokeFaultPlan
): ModelGateway {
  return {
    async *run(request: ModelRequest): AsyncIterable<ModelEvent> {
      const key = targetKey(request.provider, request.modelId);
      const stalls = plan.stalls.get(key) ?? 0;
      if (stalls > 0) {
        plan.stalls.set(key, stalls - 1);
        yield* stallUntilAborted(request.signal);
        return;
      }
      const failure = plan.retryableFailures.get(key);
      if (failure && failure.count > 0) {
        plan.retryableFailures.set(key, {
          count: failure.count - 1,
          kind: failure.kind
        });
        yield {
          type: "error",
          kind: failure.kind,
          status: failure.kind === "rate_limited" ? 429 : 503,
          code: INJECTED_FAILURE_CODE,
          message: "Injected Provider failure for the smoke matrix"
        };
        return;
      }
      yield* gateway.run(request);
    }
  };
}

export type ProviderSmokeRunnerDependencies = {
  gateway: ModelGateway;
  cipher: CredentialCipher;
  modelContext: (input: { provider: ProviderId; modelId: string }) => ModelContext;
  clock?: () => IsoDate;
  workspaceId?: string;
};

type SmokeRunOptions = {
  modelContext?: (input: { provider: ProviderId; modelId: string }) => ModelContext;
  providerTimeoutMs?: number;
};

type ScenarioContext = {
  store: MemoryStore;
  config: ProviderSmokeRunConfig;
  clock: () => IsoDate;
  faults: ProviderSmokeFaultPlan;
  /** Each scenario needs its own Conversation: one active Discussion at a time. */
  nextConversationId: () => Promise<string>;
  createRuns: (options?: SmokeRunOptions) => ConversationRunService;
  createOrchestrator: (runs: ConversationRunService) => DiscussionOrchestrator;
};

/** The live services and Discussion one Smoke scenario drives. */
type ScenarioSession = {
  runs: ConversationRunService;
  orchestrator: DiscussionOrchestrator;
  discussion: string;
};

function attemptRecord(attempt: ProviderAttempt): ProviderSmokeAttemptRecord {
  return {
    provider: attempt.provider,
    modelId: attempt.modelId,
    targetOrder: attempt.targetOrder,
    attempt: attempt.attempt,
    status: attempt.status,
    ...(attempt.errorKind ? { errorKind: attempt.errorKind } : {}),
    ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
    ...(attempt.fallbackFromAttemptId
      ? { fallbackFromAttemptId: attempt.fallbackFromAttemptId }
      : {}),
    usage: attempt.usage,
    estimatedCostMicros: attempt.estimatedCostMicros ?? null
  };
}

async function seedWorkspace(input: {
  store: MemoryStore;
  cipher: CredentialCipher;
  config: ProviderSmokeRunConfig;
  clock: () => IsoDate;
}): Promise<void> {
  const { store, cipher, config, clock } = input;
  const primary = config.targets[0];
  const fallback = config.targets.find((target) => target.role === "fallback");
  const timestamp = clock();
  await store.update((state) => {
    const providerIdFor = (role: "primary" | "fallback") =>
      `smoke-provider-${role}`;
    state.providers.push({
      id: providerIdFor("primary"),
      workspaceId: state.workspace.id,
      provider: primary.provider,
      label: `Smoke primary (${primary.provider})`,
      encryptedCredential: cipher.encrypt(primary.credential),
      createdAt: timestamp,
      updatedAt: timestamp
    });
    if (fallback) {
      state.providers.push({
        id: providerIdFor("fallback"),
        workspaceId: state.workspace.id,
        provider: fallback.provider,
        label: `Smoke fallback (${fallback.provider})`,
        encryptedCredential: cipher.encrypt(fallback.credential),
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }
    state.employees.push(
      {
        id: ANALYST_EMPLOYEE_ID,
        workspaceId: state.workspace.id,
        name: "Smoke Analyst",
        identity: "You are a precise analyst.",
        providerCredentialId: providerIdFor("primary"),
        modelId: primary.modelId,
        ...(fallback
          ? {
              fallbackTargets: [
                {
                  providerCredentialId: providerIdFor("fallback"),
                  modelId: fallback.modelId
                }
              ]
            }
          : {}),
        skillIds: [],
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: FACILITATOR_EMPLOYEE_ID,
        workspaceId: state.workspace.id,
        name: "Smoke Facilitator",
        identity: "You are a decisive facilitator.",
        providerCredentialId: providerIdFor("primary"),
        modelId: primary.modelId,
        skillIds: [],
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    );
    // Stamp a Pricing snapshot per target so every attempt in the smoke
    // workspace carries a real estimated cost instead of an unknown one.
    const pricingFor = (target: ProviderSmokeTarget) =>
      ({
        id: `smoke-pricing-${target.role}`,
        workspaceId: state.workspace.id,
        provider: target.provider,
        modelId: target.modelId,
        currency: "USD",
        inputMicrosPerMillionTokens:
          config.pricing.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens:
          config.pricing.outputMicrosPerMillionTokens,
        effectiveAt: timestamp,
        source: "provider_smoke",
        version: "smoke-default",
        createdAt: timestamp
      }) satisfies ModelPricing;
    state.modelPricing.push(...config.targets.map(pricingFor));
  });
}

async function createScenarioDiscussion(input: {
  store: MemoryStore;
  orchestrator: DiscussionOrchestrator;
  conversationId: string;
  title: string;
  maxRounds: number;
}): Promise<string> {
  const view = await input.orchestrator.createDiscussion(input.conversationId, {
    title: input.title,
    mode: "solution",
    language: "en",
    maxRounds: input.maxRounds,
    participants: [
      { employeeId: ANALYST_EMPLOYEE_ID, role: "analyst" },
      { employeeId: FACILITATOR_EMPLOYEE_ID, role: "facilitator" }
    ],
    facilitatorId: FACILITATOR_EMPLOYEE_ID
  });
  return view.discussion.id;
}

/**
 * Every Smoke scenario drives one fresh Conversation through the real
 * services; this opens that Conversation and its single Discussion.
 */
async function openScenario(
  context: ScenarioContext,
  title: string,
  maxRounds: number
): Promise<ScenarioSession> {
  const runs = context.createRuns();
  const orchestrator = context.createOrchestrator(runs);
  const discussion = await createScenarioDiscussion({
    orchestrator,
    store: context.store,
    conversationId: await context.nextConversationId(),
    title,
    maxRounds
  });
  return { runs, orchestrator, discussion };
}

async function queuedRunId(
  store: MemoryStore,
  discussionId: string
): Promise<string> {
  const runId = await store.read(
    (state) =>
      state.runs.find(
        (run) =>
          run.discussionId === discussionId && run.status === "queued"
      )?.id
  );
  if (!runId) {
    throw new Error("Provider smoke scenario found no queued Run");
  }
  return runId;
}

async function startPhase(
  store: MemoryStore,
  orchestrator: DiscussionOrchestrator,
  discussionId: string
): Promise<string> {
  await orchestrator.startDiscussion(discussionId);
  return queuedRunId(store, discussionId);
}

async function advancePhase(
  store: MemoryStore,
  orchestrator: DiscussionOrchestrator,
  discussionId: string
): Promise<string> {
  await orchestrator.advanceDiscussion(discussionId);
  return queuedRunId(store, discussionId);
}

async function runAttempts(
  store: MemoryStore,
  runId: string
): Promise<ProviderSmokeAttemptRecord[]> {
  return store.read((state) =>
    state.providerAttempts
      .filter((attempt) => attempt.runId === runId)
      .map(attemptRecord)
  );
}

function scenarioOutcome(
  passed: boolean,
  failedReason: string,
  outcome: Omit<ProviderSmokeScenarioOutcome, "status" | "reason">
): ProviderSmokeScenarioOutcome {
  return {
    status: passed ? "passed" : "failed",
    ...(passed ? {} : { reason: failedReason }),
    ...outcome
  };
}

async function structuredOutputScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const { runs, orchestrator, discussion } = await openScenario(
    context,
    "Provider smoke structured output",
    3
  );
  const runId = await startPhase(context.store, orchestrator, discussion);
  await runs.processRun(runId);
  const attempts = await runAttempts(context.store, runId);
  const turns = await context.store.read(
    (state) =>
      state.discussions
        .find((item) => item.id === discussion)!
        .rounds.at(-1)!.turns
  );
  const payloadTurns = turns.filter((turn) => turn.payload).length;
  return scenarioOutcome(payloadTurns === turns.length, "Positions Turns did not return validated payloads", {
    attempts,
    detail: { payloadTurns, turns: turns.length }
  });
}

async function usageCaptureScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const { runs, orchestrator, discussion } = await openScenario(
    context,
    "Provider smoke usage capture",
    3
  );
  const runId = await startPhase(context.store, orchestrator, discussion);
  await runs.processRun(runId);
  const attempts = await runAttempts(context.store, runId);
  const reported = attempts.filter(
    (attempt) =>
      attempt.status === "succeeded" &&
      attempt.usage.source === "provider" &&
      (attempt.usage.totalTokens ?? 0) > 0
  );
  return scenarioOutcome(
    reported.length > 0,
    "No Provider attempt reported Provider-supplied token usage",
    {
      attempts,
      detail: {
        attempts: attempts.length,
        attemptsWithUsage: reported.length,
        usageSource: attempts[0]?.usage.source ?? "unknown"
      }
    }
  );
}

/**
 * Filler used to grow completed Round history past the pressure window. It
 * pads the Turn assumptions because those reach the Discussion context plan
 * without also inflating the Evidence list or the phase context.
 */
const PRESSURE_FILLER = "Historical analysis detail. ";
const PRESSURE_PADDING_REPEATS = 385;

/**
 * Grow every completed Turn older than the newest completed Round, so the next
 * plan has to compress them instead of carrying their raw history.
 */
async function growCompletedTurns(
  store: MemoryStore,
  discussionId: string
): Promise<void> {
  const filler = PRESSURE_FILLER.repeat(PRESSURE_PADDING_REPEATS);
  await store.update((state) => {
    const discussion = state.discussions.find(
      (item) => item.id === discussionId
    );
    if (!discussion) throw new Error("Provider smoke Discussion is missing");
    const newestCompletedRound = Math.max(
      ...discussion.rounds
        .filter((round) =>
          round.turns.some((turn) => turn.status === "completed")
        )
        .map((round) => round.roundNumber)
    );
    for (const round of discussion.rounds) {
      if (round.roundNumber >= newestCompletedRound) continue;
      for (const turn of round.turns) {
        if (turn.status !== "completed" || !turn.payload) continue;
        turn.payload.assumptions.push(filler);
      }
    }
  });
}

/**
 * Grow a Discussion past its context window so the Run has to compress
 * completed Rounds before the next Provider call.
 *
 * Two content Rounds complete normally and the next Run is started while that
 * history is still small, so the phase context the Orchestrator records keeps
 * its real shape. The Turns older than the newest completed Round are then
 * grown before that Run is processed, leaving the Run to plan against a window
 * its compressible history outgrows.
 */
async function preparePressuredDiscussion(context: ScenarioContext): Promise<{
  attempts: ProviderSmokeAttemptRecord[];
  compressions: number;
  compressionId?: string;
  discussion: string;
  runId: string;
  runOutcome: string;
  runErrorCode?: string;
}> {
  const { runs, orchestrator, discussion } = await openScenario(
    context,
    "Provider smoke context pressure",
    4
  );
  await runs.processRun(
    await startPhase(context.store, orchestrator, discussion)
  );
  await runs.processRun(
    await advancePhase(context.store, orchestrator, discussion)
  );
  const pressureRun = await advancePhase(
    context.store,
    orchestrator,
    discussion
  );
  await growCompletedTurns(context.store, discussion);
  const pressuredRuns = context.createRuns({
    modelContext: () => ({
      contextWindow: PRESSURED_CONTEXT_WINDOW,
      maxOutputTokens: 512,
      available: true,
      supportsStructuredOutput: true
    })
  });
  await pressuredRuns.processRun(pressureRun);
  const run = await context.store.read(
    (state) => state.runs.find((item) => item.id === pressureRun)!
  );
  const compressions = await context.store.read((state) =>
    state.discussionCompressions.filter(
      (compression) => compression.discussionId === discussion
    )
  );
  return {
    attempts: await runAttempts(context.store, pressureRun),
    compressions: compressions.length,
    ...(compressions[0] ? { compressionId: compressions[0].id } : {}),
    discussion,
    runId: pressureRun,
    runOutcome: run.status,
    ...(run.errorCode ? { runErrorCode: run.errorCode } : {})
  };
}

async function contextPressureScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const result = await preparePressuredDiscussion(context);
  const completed = result.attempts.some(
    (attempt) => attempt.status === "succeeded"
  );
  return scenarioOutcome(
    completed,
    `The pressured Round settled as ${result.runOutcome}${
      result.runErrorCode ? ` (${result.runErrorCode})` : ""
    } without a successful Provider attempt`,
    {
      attempts: result.attempts,
      detail: {
        compressions: result.compressions,
        runOutcome: result.runOutcome,
        runErrorCode: result.runErrorCode ?? "none"
      }
    }
  );
}

async function compressionScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const result = await preparePressuredDiscussion(context);
  const compression = await context.store.read((state) =>
    state.discussionCompressions.find(
      (item) => item.id === result.compressionId
    )
  );
  const sourceLinked =
    Boolean(compression) &&
    compression!.sourceRoundIds.length > 0 &&
    compression!.sourceTurnIds.length > 0;
  return scenarioOutcome(
    Boolean(compression) && sourceLinked,
    "No source-linked Compression record was produced",
    {
      attempts: result.attempts,
      artifactLinks: compression
        ? [`artifact://discussion-compression/${compression.id}`]
        : [],
      detail: {
        sourceRounds: compression?.sourceRoundIds.length ?? 0,
        sourceTurns: compression?.sourceTurnIds.length ?? 0,
        strategy: compression?.strategy ?? "none"
      }
    }
  );
}

async function retryScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const { runs, orchestrator, discussion } = await openScenario(
    context,
    "Provider smoke retry",
    3
  );
  const primary = context.config.targets[0];
  context.faults.retryableFailures.set(
    targetKey(primary.provider, primary.modelId),
    { count: 1, kind: "rate_limited" }
  );
  const runId = await startPhase(context.store, orchestrator, discussion);
  await runs.processRun(runId);
  const attempts = await runAttempts(context.store, runId);
  const failed = attempts.find(
    (attempt) =>
      attempt.status === "failed" && attempt.errorKind === "rate_limited"
  );
  // Retry must resolve on the same target: a failover that jumps to the
  // fallback target would otherwise satisfy both flags without retrying.
  const recovered =
    failed &&
    attempts.find(
      (attempt) =>
        attempt.status === "succeeded" &&
        attempt.targetOrder === failed.targetOrder &&
        attempt.provider === failed.provider &&
        attempt.modelId === failed.modelId &&
        attempt.attempt > failed.attempt
    );
  const retriedSameTarget = Boolean(recovered);
  return scenarioOutcome(
    retriedSameTarget,
    "The injected retryable failure did not produce a retry on the same Provider target",
    {
      attempts,
      detail: {
        attempts: attempts.length,
        injectedCode: INJECTED_FAILURE_CODE,
        retriedSameTarget
      }
    }
  );
}

async function failoverScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const fallback = context.config.targets.find(
    (target) => target.role === "fallback"
  );
  if (!fallback) {
    return { status: "failed", reason: "No fallback target is configured.", attempts: [] };
  }
  const { runs, orchestrator, discussion } = await openScenario(
    context,
    "Provider smoke failover",
    3
  );
  const primary = context.config.targets[0];
  context.faults.retryableFailures.set(
    targetKey(primary.provider, primary.modelId),
    { count: 99, kind: "retryable" }
  );
  const runId = await startPhase(context.store, orchestrator, discussion);
  await runs.processRun(runId);
  const attempts = await runAttempts(context.store, runId);
  const fellOver = attempts.some(
    (attempt) =>
      attempt.provider === fallback.provider &&
      attempt.status === "succeeded" &&
      Boolean(attempt.fallbackFromAttemptId)
  );
  return scenarioOutcome(
    fellOver,
    "The fallback target did not take over the failed primary Provider attempt",
    {
      attempts,
      detail: {
        fallbackProvider: fallback.provider,
        fallbackModel: fallback.modelId,
        fellOver
      }
    }
  );
}

async function cancellationScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const { runs, orchestrator, discussion } = await openScenario(
    context,
    "Provider smoke cancellation",
    3
  );
  const primary = context.config.targets[0];
  context.faults.stalls.set(targetKey(primary.provider, primary.modelId), 1);
  const runId = await startPhase(context.store, orchestrator, discussion);
  const processing = runs.processRun(runId);
  await waitForAttempt(context.store, runId);
  await runs.cancelRun(runId);
  await processing;
  const run = await context.store.read(
    (state) => state.runs.find((item) => item.id === runId)!
  );
  const attempts = await runAttempts(context.store, runId);
  const settled = attempts.every((attempt) => attempt.status !== "started");
  return scenarioOutcome(
    run.status === "cancelled" && settled,
    `Cancelling an active Run settled it as ${run.status}`,
    {
      attempts,
      detail: {
        runOutcome: run.status,
        unsettledAttempts: attempts.filter(
          (attempt) => attempt.status === "started"
        ).length
      }
    }
  );
}

async function waitForAttempt(
  store: MemoryStore,
  runId: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const started = await store.read((state) =>
      state.providerAttempts.some((item) => item.runId === runId)
    );
    if (started) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Provider smoke cancellation never observed a Provider attempt");
}

async function briefGenerationScenario(
  context: ScenarioContext
): Promise<ProviderSmokeScenarioOutcome> {
  const { runs, orchestrator, discussion } = await openScenario(
    context,
    "Provider smoke Brief generation",
    2
  );
  await runs.processRun(await startPhase(context.store, orchestrator, discussion));
  await runs.processRun(
    await advancePhase(context.store, orchestrator, discussion)
  );
  const synthesisRunId = await advancePhase(
    context.store,
    orchestrator,
    discussion
  );
  await runs.processRun(synthesisRunId);
  // The Orchestrator settles the Synthesis Run into a Discussion Brief, so the
  // next advance is what publishes the Artifact this scenario links.
  await orchestrator.advanceDiscussion(discussion);
  const artifact = await context.store.read((state) => {
    const current = state.discussions.find((item) => item.id === discussion)!;
    return current.latestBriefArtifactId
      ? state.artifacts.find(
          (item) => item.id === current.latestBriefArtifactId
        )
      : undefined;
  });
  const attempts = await runAttempts(context.store, synthesisRunId);
  if (!artifact) {
    return {
      status: "failed",
      reason: "The synthesis Round produced no Discussion Brief artifact",
      attempts
    };
  }
  let options = 0;
  let valid = true;
  try {
    options = parseDiscussionBrief(artifact.content).options.length;
  } catch {
    valid = false;
  }
  return scenarioOutcome(valid, "The Discussion Brief artifact did not parse", {
    attempts,
    artifactLinks: [`artifact://discussion-brief/${artifact.id}`],
    detail: {
      revision: artifact.revision ?? 0,
      options
    }
  });
}

const EXECUTORS: Record<
  ProviderSmokeScenario,
  (context: ScenarioContext) => Promise<ProviderSmokeScenarioOutcome>
> = {
  structured_output: structuredOutputScenario,
  usage_capture: usageCaptureScenario,
  context_pressure: contextPressureScenario,
  compression: compressionScenario,
  retry: retryScenario,
  failover: failoverScenario,
  cancellation: cancellationScenario,
  brief_generation: briefGenerationScenario
};

/**
 * Run the opt-in Provider smoke matrix against the production services and
 * adapters, then prove the redacted report is complete and within caps.
 */
export async function runProviderSmokeMatrixAgainstProviders(
  config: ProviderSmokeRunConfig,
  dependencies: ProviderSmokeRunnerDependencies
): Promise<ProviderSmokeReport> {
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const store = new MemoryStore(
    createInitialState(dependencies.workspaceId ?? DEFAULT_WORKSPACE_ID)
  );
  const cipher = dependencies.cipher;
  await seedWorkspace({ store, cipher, config, clock });
  let conversationCount = 0;
  const nextConversationId = async (): Promise<string> => {
    conversationCount += 1;
    const id = `smoke-conversation-${conversationCount}`;
    await store.update((state) => {
      state.conversations.push({
        id,
        workspaceId: state.workspace.id,
        title: `Provider smoke conversation ${conversationCount}`,
        memberIds: [ANALYST_EMPLOYEE_ID, FACILITATOR_EMPLOYEE_ID],
        createdAt: clock(),
        updatedAt: clock()
      });
    });
    return id;
  };
  const scenarioContext = (
    faults: ProviderSmokeFaultPlan,
    gateway: ModelGateway
  ): ScenarioContext => ({
    store,
    config,
    clock,
    faults,
    nextConversationId,
    createRuns: (options = {}) =>
      new ConversationRunService(store, cipher, gateway, {
        modelContext: options.modelContext ?? dependencies.modelContext,
        providerTimeoutMs: options.providerTimeoutMs ?? config.limits.timeoutMs
      }),
    createOrchestrator: (runs) => new DiscussionOrchestrator(store, runs)
  });
  const report = await runProviderSmokeMatrix({
    config,
    clock: clock as () => IsoDate,
    executor: async ({ scenario }) => {
      // Every scenario gets a fresh fault plan: an unconsumed injected
      // failure must never leak into a later scenario's Provider calls.
      const faults = createProviderSmokeFaultPlan();
      return EXECUTORS[scenario](
        scenarioContext(
          faults,
          injectProviderSmokeFaults(dependencies.gateway, faults)
        )
      );
    }
  });
  validateProviderSmokeReport(report);
  assertProviderSmokeReportOmitsCredentials(
    report,
    config.targets.map((target) => target.credential)
  );
  return report;
}
