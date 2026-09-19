import {
  aggregateAttemptCosts,
  type AttemptCostAggregate
} from "@/server/application/model-pricing";
import {
  aggregateModelUsage,
  type AggregatedModelUsage
} from "@/server/application/model-usage";
import { evaluateDiscussionBudget } from "@/server/application/discussion-budget";
import type {
  AppState,
  Conversation,
  Discussion,
  ProviderAttempt,
  Run
} from "@/server/domain/types";
import type {
  UsageBreakdownEntry,
  UsageConversationBreakdown,
  UsageDiscussionBreakdown,
  UsageDiscussionBudget,
  UsageModelBreakdown,
  UsageProviderBreakdown,
  UsageTokenTotals,
  UsageView,
  UsageWindow
} from "@/lib/usage-view";

export const DEFAULT_USAGE_WINDOW: UsageWindow = "30d";

export type UsageViewOptions = {
  window?: UsageWindow;
  clock?: () => Date;
};

const WINDOW_HOURS: Record<Exclude<UsageWindow, "all">, number> = {
  "7d": 7 * 24,
  "30d": 30 * 24
};

/** Opaque Map key; never parsed back apart. */
const GROUP_KEY_SEPARATOR = "\u0000";

function windowHours(window: UsageWindow): number | null {
  return window === "all" ? null : WINDOW_HOURS[window];
}

type AttemptSummary = {
  attemptCount: number;
  usage: AggregatedModelUsage;
  cost: AttemptCostAggregate;
};

function summarize(
  state: AppState,
  attempts: ProviderAttempt[]
): AttemptSummary {
  return {
    attemptCount: attempts.length,
    usage: aggregateModelUsage(attempts),
    cost: aggregateAttemptCosts(state, attempts)
  };
}

function tokenTotals(usage: AggregatedModelUsage): UsageTokenTotals {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    source: usage.source
  };
}

function breakdownEntry(summary: AttemptSummary): UsageBreakdownEntry {
  return {
    tokens: tokenTotals(summary.usage),
    costTotals: summary.cost.totals
  };
}

type Lookups = {
  runs: Map<string, Run>;
  discussions: Map<string, Discussion>;
  conversations: Map<string, Conversation>;
};

function lookupsOf(state: AppState): Lookups {
  return {
    runs: new Map(state.runs.map((run) => [run.id, run])),
    discussions: new Map(
      state.discussions.map((discussion) => [discussion.id, discussion])
    ),
    conversations: new Map(
      state.conversations.map((conversation) => [conversation.id, conversation])
    )
  };
}

/**
 * An attempt reaches its Conversation through its Run; a model re-ranking
 * attempt carries no Run, so it reaches it through its Discussion instead.
 */
function conversationIdOf(
  attempt: ProviderAttempt,
  lookups: Lookups
): string | undefined {
  if (attempt.runId) {
    const run = lookups.runs.get(attempt.runId);
    if (run) return run.conversationId;
  }
  if (attempt.discussionId) {
    return lookups.discussions.get(attempt.discussionId)?.conversationId;
  }
  return undefined;
}

function groupAttemptsByKey(
  attempts: ProviderAttempt[],
  keyOf: (attempt: ProviderAttempt) => string | undefined
): Map<string, ProviderAttempt[]> {
  const groups = new Map<string, ProviderAttempt[]>();
  for (const attempt of attempts) {
    const key = keyOf(attempt);
    if (key === undefined) continue;
    const group = groups.get(key);
    if (group) {
      group.push(attempt);
    } else {
      groups.set(key, [attempt]);
    }
  }
  return groups;
}

function discussionBudget(
  state: AppState,
  discussion: Discussion
): UsageDiscussionBudget | null {
  const evaluation = evaluateDiscussionBudget(state, discussion);
  if (evaluation.source === "none") return null;
  return {
    source: evaluation.source,
    tokens: {
      used: evaluation.tokens.used,
      soft: evaluation.tokens.soft,
      hard: evaluation.tokens.hard,
      unknownAttempts: evaluation.tokens.unknownUsageAttemptCount,
      state: evaluation.tokens.state
    },
    cost: {
      usedMicros: evaluation.cost.usedMicros,
      softMicros: evaluation.cost.softMicros,
      hardMicros: evaluation.cost.hardMicros,
      currency: evaluation.cost.currency,
      unknownAttempts: evaluation.cost.unknownCostAttemptCount,
      state: evaluation.cost.state
    }
  };
}

function costIn(entry: UsageBreakdownEntry, currency: string): number {
  return (
    entry.costTotals.find((total) => total.currency === currency)?.costMicros ??
    0
  );
}

/**
 * Ranks a breakdown most expensive first. Cost is only comparable within a
 * currency, so cost ordering applies when the window holds a single
 * currency; otherwise total tokens — which carry no currency — order the
 * rows. The label settles the remaining ties.
 */
function sortedBreakdown<T extends UsageBreakdownEntry>(
  entries: T[],
  currency: string | null,
  label: (entry: T) => string
): T[] {
  return entries.sort((left, right) => {
    if (currency !== null) {
      const byCost = costIn(right, currency) - costIn(left, currency);
      if (byCost !== 0) return byCost;
    }
    const byTokens =
      (right.tokens.totalTokens ?? 0) - (left.tokens.totalTokens ?? 0);
    if (byTokens !== 0) return byTokens;
    return label(left).localeCompare(label(right));
  });
}

/**
 * Rolls Provider-attempt usage and cost up to workspace totals and to
 * per-Model and per-Provider breakdowns over a window. Pure: reads only the
 * given state, resolves no I/O, and reuses the cost model rather than
 * recomputing it.
 */
export function buildUsageView(
  state: AppState,
  options: UsageViewOptions = {}
): UsageView {
  const window = options.window ?? DEFAULT_USAGE_WINDOW;
  const now = (options.clock ?? (() => new Date()))();
  const hours = windowHours(window);
  const sinceMs = hours === null ? null : now.getTime() - hours * 60 * 60_000;
  const attempts = state.providerAttempts.filter(
    (attempt) => sinceMs === null || Date.parse(attempt.startedAt) >= sinceMs
  );

  const totals = summarize(state, attempts);
  const currency =
    totals.cost.totals.length === 1 ? totals.cost.totals[0].currency : null;
  const lookups = lookupsOf(state);

  const byModel: UsageModelBreakdown[] = sortedBreakdown(
    [
      ...groupAttemptsByKey(
        attempts,
        (attempt) =>
          `${attempt.provider}${GROUP_KEY_SEPARATOR}${attempt.modelId}`
      ).values()
    ].map((group) => ({
      provider: group[0].provider,
      modelId: group[0].modelId,
      ...breakdownEntry(summarize(state, group))
    })),
    currency,
    (entry) => `${entry.provider} ${entry.modelId}`
  );

  const byProvider: UsageProviderBreakdown[] = sortedBreakdown(
    [...groupAttemptsByKey(attempts, (attempt) => attempt.provider).values()].map(
      (group) => ({
        provider: group[0].provider,
        ...breakdownEntry(summarize(state, group))
      })
    ),
    currency,
    (entry) => entry.provider
  );

  const byDiscussion: UsageDiscussionBreakdown[] = sortedBreakdown(
    [
      ...groupAttemptsByKey(attempts, (attempt) => attempt.discussionId).entries()
    ].flatMap(([discussionId, group]) => {
      const discussion = lookups.discussions.get(discussionId);
      if (!discussion) return [];
      return [
        {
          discussionId,
          conversationId: discussion.conversationId,
          title: discussion.title,
          budget: discussionBudget(state, discussion),
          ...breakdownEntry(summarize(state, group))
        }
      ];
    }),
    currency,
    (entry) => entry.title
  );

  const byConversation: UsageConversationBreakdown[] = sortedBreakdown(
    [
      ...groupAttemptsByKey(attempts, (attempt) =>
        conversationIdOf(attempt, lookups)
      ).entries()
    ].map(([conversationId, group]) => ({
      conversationId,
      title: lookups.conversations.get(conversationId)?.title ?? conversationId,
      ...breakdownEntry(summarize(state, group))
    })),
    currency,
    (entry) => entry.title
  );

  // An attempt with unknown usage can never be priced, so every unknown-usage
  // attempt is already unpriced. Whatever remains unpriced beyond those is
  // spend whose model has no Pricing snapshot.
  const unknownUsageAttempts = totals.usage.unknownUsageAttemptCount;
  const unknownPricingAttempts =
    totals.attemptCount - totals.cost.pricedAttemptCount - unknownUsageAttempts;

  return {
    generatedAt: now.toISOString(),
    window: {
      kind: window,
      hours,
      ...(sinceMs === null ? {} : { since: new Date(sinceMs).toISOString() })
    },
    attemptCount: totals.attemptCount,
    tokens: tokenTotals(totals.usage),
    cost: {
      totals: totals.cost.totals,
      pricedAttemptCount: totals.cost.pricedAttemptCount
    },
    coverage: { unknownUsageAttempts, unknownPricingAttempts },
    byModel,
    byProvider,
    byDiscussion,
    byConversation,
    empty: totals.attemptCount === 0
  };
}
