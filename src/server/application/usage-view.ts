import {
  aggregateAttemptCosts,
  type AttemptCostAggregate
} from "@/server/application/model-pricing";
import {
  aggregateModelUsage,
  type AggregatedModelUsage
} from "@/server/application/model-usage";
import type { AppState, ProviderAttempt } from "@/server/domain/types";
import type { ProviderId } from "@/lib/provider-catalog";
import type {
  UsageBreakdownEntry,
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

type ModelGroup = {
  provider: ProviderId;
  modelId: string;
  attempts: ProviderAttempt[];
};

type ProviderGroup = {
  provider: ProviderId;
  attempts: ProviderAttempt[];
};

/**
 * A Model is identified by the Provider that serves it as well as its model
 * id, matching how ModelPricing and the cost aggregate key a model.
 */
function groupByModel(attempts: ProviderAttempt[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const attempt of attempts) {
    const key = `${attempt.provider}${GROUP_KEY_SEPARATOR}${attempt.modelId}`;
    const group = groups.get(key);
    if (group) {
      group.attempts.push(attempt);
    } else {
      groups.set(key, {
        provider: attempt.provider,
        modelId: attempt.modelId,
        attempts: [attempt]
      });
    }
  }
  return [...groups.values()];
}

function groupByProvider(attempts: ProviderAttempt[]): ProviderGroup[] {
  const groups = new Map<ProviderId, ProviderAttempt[]>();
  for (const attempt of attempts) {
    const group = groups.get(attempt.provider);
    if (group) {
      group.push(attempt);
    } else {
      groups.set(attempt.provider, [attempt]);
    }
  }
  return [...groups.entries()].map(([provider, group]) => ({
    provider,
    attempts: group
  }));
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

  const byModel: UsageModelBreakdown[] = sortedBreakdown(
    groupByModel(attempts).map((group) => ({
      provider: group.provider,
      modelId: group.modelId,
      ...breakdownEntry(summarize(state, group.attempts))
    })),
    currency,
    (entry) => `${entry.provider} ${entry.modelId}`
  );

  const byProvider: UsageProviderBreakdown[] = sortedBreakdown(
    groupByProvider(attempts).map((group) => ({
      provider: group.provider,
      ...breakdownEntry(summarize(state, group.attempts))
    })),
    currency,
    (entry) => entry.provider
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
    empty: totals.attemptCount === 0
  };
}
