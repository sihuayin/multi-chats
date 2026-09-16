import { attemptCost } from "@/server/application/model-pricing";
import { evaluateDiscussionBudget } from "@/server/application/discussion-budget";
import type {
  AppState,
  ProviderAttempt
} from "@/server/domain/types";
import type {
  DiagnosticsDiscussion,
  DiagnosticsFailure,
  DiagnosticsHealth,
  DiagnosticsProvider,
  DiagnosticsRun,
  DiagnosticsView
} from "@/lib/diagnostics-view";

const WINDOW_HOURS = 24;
const WORKER_STALE_MS = 15_000;
const MAX_PROVIDER_ATTEMPTS = 50;
const FAILURE_STATUSES = new Set<ProviderAttempt["status"]>([
  "failed",
  "cancelled",
  "interrupted",
  "ambiguous"
]);

function hasUsage(attempt: ProviderAttempt): boolean {
  return [
    attempt.usage.inputTokens,
    attempt.usage.outputTokens,
    attempt.usage.cachedInputTokens,
    attempt.usage.cacheWriteTokens,
    attempt.usage.cacheWrite1hTokens,
    attempt.usage.reasoningTokens,
    attempt.usage.totalTokens
  ].some((value) => value !== undefined);
}

function activityStatus(status: ProviderAttempt["status"]): DiagnosticsHealth {
  if (status === "succeeded") return "healthy";
  if (status === "started") return "unknown";
  return "degraded";
}

function runSummary(
  state: AppState,
  run: AppState["runs"][number]
): DiagnosticsRun {
  const conversation = state.conversations.find(
    (item) => item.id === run.conversationId
  );
  const task = run.taskId
    ? state.tasks.find((item) => item.id === run.taskId)
    : undefined;
  const discussion = run.discussionId
    ? state.discussions.find((item) => item.id === run.discussionId)
    : undefined;
  return {
    id: run.id,
    status: run.status,
    conversationId: run.conversationId,
    conversationTitle: conversation?.title ?? run.conversationId,
    ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
    ...(discussion
      ? { discussionId: discussion.id, discussionTitle: discussion.title }
      : {}),
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt
  };
}

function providerSummaries(
  state: AppState,
  recentAttempts: ProviderAttempt[]
): DiagnosticsProvider[] {
  return state.providers.map((provider) => {
    const attempts = state.providerAttempts
      .filter((attempt) => attempt.provider === provider.provider)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const recent = recentAttempts.filter(
      (attempt) => attempt.provider === provider.provider
    );
    const latest = recent[0];
    const status: DiagnosticsHealth = latest
      ? activityStatus(latest.status)
      : attempts.length > 0
        ? "stale"
        : "unknown";
    return {
      id: provider.id,
      label: provider.label,
      provider: provider.provider,
      status,
      ...(provider.lastValidatedAt
        ? { lastValidatedAt: provider.lastValidatedAt }
        : {}),
      ...(latest
        ? {
            lastAttemptAt: latest.startedAt,
            lastErrorKind: latest.errorKind,
            lastErrorCode: latest.errorCode
          }
        : attempts[0]
          ? { lastAttemptAt: attempts[0].startedAt }
          : {}),
      recentAttemptCount: recent.length
    };
  });
}

function discussionSummaries(state: AppState): DiagnosticsDiscussion[] {
  return state.discussions
    .filter((discussion) =>
      ["running", "interrupted"].includes(discussion.status)
    )
    .map((discussion) => {
      const budget = evaluateDiscussionBudget(state, discussion);
      const events = discussion.events ?? [];
      let reason: string | undefined;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventReason =
          typeof event.payload.reason === "string"
            ? event.payload.reason
            : undefined;
        const eventCode =
          typeof event.payload.code === "string"
            ? event.payload.code
            : undefined;
        const dimension =
          typeof event.payload.dimension === "string"
            ? event.payload.dimension
            : undefined;
        reason =
          eventReason ??
          eventCode ??
          (event.type === "discussion_budget_exhausted" && dimension
            ? `${event.type}:${dimension}`
            : undefined);
        if (reason) break;
      }
      if (!reason && discussion.status === "interrupted") {
        reason = "interrupted";
      }
      return {
        id: discussion.id,
        conversationId: discussion.conversationId,
        title: discussion.title,
        mode: discussion.mode,
        status: discussion.status,
        currentRound: discussion.currentRound,
        maxRounds: discussion.maxRounds,
        ...(reason ? { reason } : {}),
        pendingInterventionCount: state.discussionInterventions.filter(
          (intervention) =>
            intervention.discussionId === discussion.id &&
            intervention.status === "pending"
        ).length,
        tokenBudgetState: budget.tokens.state,
        costBudgetState: budget.cost.state,
        tokensUsed: budget.tokens.used,
        costUsedMicros: budget.cost.usedMicros,
        currency: budget.cost.currency
      };
    });
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function failureSummaries(attempts: ProviderAttempt[]): DiagnosticsFailure[] {
  const groups = new Map<
    string,
    {
      provider: string;
      modelId: string;
      attempts: ProviderAttempt[];
    }
  >();
  for (const attempt of attempts) {
    if (!FAILURE_STATUSES.has(attempt.status)) continue;
    const key = `${attempt.provider}\u0000${attempt.modelId}`;
    const group = groups.get(key) ?? {
      provider: attempt.provider,
      modelId: attempt.modelId,
      attempts: []
    };
    group.attempts.push(attempt);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const ordered = group.attempts.sort((left, right) =>
        right.startedAt.localeCompare(left.startedAt)
      );
      return {
        provider: group.provider,
        modelId: group.modelId,
        count: ordered.length,
        statuses: unique(ordered.map((attempt) => attempt.status)),
        errorKinds: unique(ordered.map((attempt) => attempt.errorKind)),
        errorCodes: unique(ordered.map((attempt) => attempt.errorCode)),
        lastOccurredAt: ordered[0].startedAt
      };
    })
    .sort(
      (left, right) =>
        right.lastOccurredAt.localeCompare(left.lastOccurredAt) ||
        left.provider.localeCompare(right.provider) ||
        left.modelId.localeCompare(right.modelId)
    );
}

export function buildDiagnosticsView(
  state: AppState,
  clock: () => Date = () => new Date()
): DiagnosticsView {
  const now = clock();
  const cutoff = now.getTime() - WINDOW_HOURS * 60 * 60_000;
  const attemptsInWindow = state.providerAttempts
    .filter((attempt) => Date.parse(attempt.startedAt) >= cutoff)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const recentAttempts = attemptsInWindow.slice(0, MAX_PROVIDER_ATTEMPTS);
  const heartbeatAt = state.workspace.workerHeartbeatAt;
  const heartbeatTime = heartbeatAt ? Date.parse(heartbeatAt) : undefined;
  const heartbeatAge =
    heartbeatTime !== undefined && Number.isFinite(heartbeatTime)
      ? Math.max(0, now.getTime() - heartbeatTime)
      : undefined;
  const workerStatus: DiagnosticsHealth = !heartbeatAt
    ? "unavailable"
    : heartbeatAge === undefined
      ? "unknown"
      : heartbeatAge > WORKER_STALE_MS
        ? "stale"
        : "healthy";
  const activeRuns = state.runs
    .filter((run) =>
      ["running", "waiting_approval"].includes(run.status)
    )
    .map((run) => runSummary(state, run));
  const queuedRuns = state.runs
    .filter((run) => run.status === "queued")
    .map((run) => runSummary(state, run));

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let unknownUsageAttempts = 0;
  let estimatedCostMicros = 0;
  let unknownPricingAttempts = 0;
  const currencies = new Set<string>();
  for (const attempt of attemptsInWindow) {
    if (attempt.usage.source === "unknown" || !hasUsage(attempt)) {
      unknownUsageAttempts += 1;
    } else {
      inputTokens += attempt.usage.inputTokens ?? 0;
      outputTokens += attempt.usage.outputTokens ?? 0;
      totalTokens +=
        attempt.usage.totalTokens ??
        (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0);
    }
    const cost = attemptCost(state, attempt);
    if (cost === null) {
      unknownPricingAttempts += 1;
    } else {
      currencies.add(cost.currency);
      estimatedCostMicros += cost.costMicros;
    }
  }

  return {
    generatedAt: now.toISOString(),
    worker: {
      status: workerStatus,
      ...(heartbeatAt ? { heartbeatAt } : {}),
      ...(heartbeatAge !== undefined ? { ageMs: heartbeatAge } : {})
    },
    providers: providerSummaries(state, recentAttempts),
    runs: {
      queued: queuedRuns,
      active: activeRuns
    },
    discussions: discussionSummaries(state),
    usage: {
      windowHours: WINDOW_HOURS,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostMicros:
        currencies.size === 1 ? estimatedCostMicros : null,
      ...(currencies.size === 1
        ? { currency: [...currencies][0] }
        : {}),
      unknownUsageAttempts,
      unknownPricingAttempts,
      retryAttempts: recentAttempts.filter(
        (attempt) => attempt.attempt > 1
      ).length,
      fallbackAttempts: recentAttempts.filter(
        (attempt) =>
          attempt.targetOrder > 0 || Boolean(attempt.fallbackFromAttemptId)
      ).length
    },
    failures: failureSummaries(recentAttempts)
  };
}
