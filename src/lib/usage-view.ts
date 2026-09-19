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
  empty: boolean;
};
