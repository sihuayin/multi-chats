import { aggregateAttemptCosts } from "@/server/application/model-pricing";
import { aggregateModelUsage } from "@/server/application/model-usage";
import type { AppState } from "@/server/domain/types";
import type { UsageView, UsageWindow } from "@/lib/usage-view";

export const DEFAULT_USAGE_WINDOW: UsageWindow = "30d";

const WINDOW_HOURS: Record<Exclude<UsageWindow, "all">, number> = {
  "7d": 7 * 24,
  "30d": 30 * 24
};

function windowHours(window: UsageWindow): number | null {
  return window === "all" ? null : WINDOW_HOURS[window];
}

export type UsageViewOptions = {
  window?: UsageWindow;
  clock?: () => Date;
};

/**
 * Rolls Provider-attempt usage and cost up to workspace totals over a
 * window. Pure: reads only the given state, resolves no I/O, and reuses
 * the cost model rather than recomputing it.
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

  const usage = aggregateModelUsage(attempts);
  const cost = aggregateAttemptCosts(state, attempts);
  // An attempt with unknown usage can never be priced, so every unknown-usage
  // attempt is already unpriced. Whatever remains unpriced beyond those is
  // spend whose model has no Pricing snapshot.
  const unknownUsageAttempts = usage.unknownUsageAttemptCount;
  const unknownPricingAttempts =
    attempts.length - cost.pricedAttemptCount - unknownUsageAttempts;

  return {
    generatedAt: now.toISOString(),
    window: {
      kind: window,
      hours,
      ...(sinceMs === null ? {} : { since: new Date(sinceMs).toISOString() })
    },
    attemptCount: attempts.length,
    tokens: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      source: usage.source
    },
    cost: {
      totals: cost.totals,
      pricedAttemptCount: cost.pricedAttemptCount
    },
    coverage: { unknownUsageAttempts, unknownPricingAttempts },
    empty: attempts.length === 0
  };
}
