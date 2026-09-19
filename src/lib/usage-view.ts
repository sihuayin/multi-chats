import type { ProviderId } from "@/lib/provider-catalog";

/**
 * The window set, stated once: the union, the hours each window covers, and
 * the validity rule all derive from this list.
 */
export const USAGE_WINDOWS = [
  { kind: "7d", hours: 168 },
  { kind: "30d", hours: 720 },
  { kind: "all", hours: null }
] as const;

export type UsageWindow = (typeof USAGE_WINDOWS)[number]["kind"];

export const DEFAULT_USAGE_WINDOW: UsageWindow = "30d";

export function isUsageWindow(
  value: string | null | undefined
): value is UsageWindow {
  return (
    typeof value === "string" &&
    USAGE_WINDOWS.some((window) => window.kind === value)
  );
}

/** Null means the window has no lower bound. */
export function usageWindowHours(window: UsageWindow): number | null {
  return USAGE_WINDOWS.find((entry) => entry.kind === window)?.hours ?? null;
}

export type UsageWindowView = {
  kind: UsageWindow;
  hours: number | null;
  since?: string;
};

export type UsageTokenTotals = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated" | "unknown" | "mixed";
};

export type UsageCostTotal = {
  currency: string;
  costMicros: number;
};

export type UsageBreakdownEntry = {
  tokens: UsageTokenTotals;
  costTotals: UsageCostTotal[];
};

/** One entry's spend in a given currency, or zero when it has none. */
export function costIn(entry: UsageBreakdownEntry, currency: string): number {
  return (
    entry.costTotals.find((total) => total.currency === currency)?.costMicros ??
    0
  );
}

export type UsageModelBreakdown = UsageBreakdownEntry & {
  provider: ProviderId;
  modelId: string;
};

export type UsageProviderBreakdown = UsageBreakdownEntry & {
  provider: ProviderId;
};

/**
 * Mirrors the server's budget dimension state. Assigning a server budget
 * evaluation into these types stops compiling if that union gains a member.
 */
export type UsageBudgetState =
  | "unbounded"
  | "ok"
  | "soft"
  | "hard"
  | "unknown";

export type UsageBudgetTokens = {
  used: number;
  soft?: number;
  hard?: number;
  unknownAttempts: number;
  state: UsageBudgetState;
};

export type UsageBudgetCost = {
  usedMicros: number;
  softMicros?: number;
  hardMicros?: number;
  currency?: string;
  unknownAttempts: number;
  state: UsageBudgetState;
};

export type UsageDiscussionBudget = {
  source: "discussion" | "workspace_defaults";
  tokens: UsageBudgetTokens;
  cost: UsageBudgetCost;
};

/**
 * Spend is scoped to the visible window, but `budget` reports the
 * Discussion's whole lifetime — that is what the limits are enforced
 * against. A Discussion with no budget resolves to `null`.
 */
export type UsageDiscussionBreakdown = UsageBreakdownEntry & {
  discussionId: string;
  conversationId: string;
  title: string;
  budget: UsageDiscussionBudget | null;
};

export type UsageConversationBreakdown = UsageBreakdownEntry & {
  conversationId: string;
  title: string;
};

/**
 * One UTC calendar day of the series. `attemptCount` separates a genuinely
 * quiet day from one whose attempts could not be measured or priced.
 *
 * `partial` marks a bucket that covers less than a whole day, for either of
 * two reasons: the window's lower bound clips the day the window opens on,
 * or the bucket is today and today is not over. Its total is therefore not
 * comparable with an interior day's.
 */
export type UsageSeriesPoint = UsageBreakdownEntry & {
  day: string;
  attemptCount: number;
  partial: boolean;
};

export type UsageView = {
  generatedAt: string;
  window: UsageWindowView;
  attemptCount: number;
  tokens: UsageTokenTotals;
  cost: {
    totals: UsageCostTotal[];
    pricedAttemptCount: number;
  };
  coverage: {
    unknownUsageAttempts: number;
    unknownPricingAttempts: number;
  };
  byModel: UsageModelBreakdown[];
  byProvider: UsageProviderBreakdown[];
  byDiscussion: UsageDiscussionBreakdown[];
  byConversation: UsageConversationBreakdown[];
  series: UsageSeriesPoint[];
  empty: boolean;
};
