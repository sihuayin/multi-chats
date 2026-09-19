import type { ProviderId } from "@/lib/provider-catalog";

export type UsageWindow = "7d" | "30d" | "all";

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
  empty: boolean;
};
