import type {
  AppState,
  IsoDate,
  ModelPricing,
  ModelUsage,
  ProviderAttempt,
  ProviderAttemptPurpose,
  ProviderId
} from "@/server/domain/types";

export type CostByCurrency = {
  currency: string;
  costMicros: number;
};

export type AttemptCostAggregate = {
  totals: CostByCurrency[];
  byPurpose: Array<CostByCurrency & { purpose: ProviderAttemptPurpose }>;
  byModel: Array<CostByCurrency & { provider: ProviderId; modelId: string }>;
  pricedAttemptCount: number;
  unknownCostAttemptCount: number;
};

const MICROS_PER_MILLION_TOKENS = 1_000_000;

/**
 * Cost of one Provider attempt in integer minor units (micros), rounded
 * half-up on exact integer arithmetic. Returns null when the cost is
 * unknown (missing pricing or missing usage) rather than zero.
 */
export function computeAttemptCostMicros(
  usage: ModelUsage,
  pricing: ModelPricing | undefined
): number | null {
  if (pricing === undefined) return null;
  if (usage.source === "unknown") return null;
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  const cachedTokens = Math.min(
    usage.cachedInputTokens ?? 0,
    inputTokens
  );
  const uncachedInputTokens = inputTokens - cachedTokens;
  const cachedRate =
    pricing.cachedInputMicrosPerMillionTokens ??
    pricing.inputMicrosPerMillionTokens;
  const numerator =
    uncachedInputTokens * pricing.inputMicrosPerMillionTokens +
    cachedTokens * cachedRate +
    outputTokens * pricing.outputMicrosPerMillionTokens;
  return Math.floor(
    (numerator + MICROS_PER_MILLION_TOKENS / 2) / MICROS_PER_MILLION_TOKENS
  );
}

export function resolvePricingSnapshot(
  state: Pick<AppState, "modelPricing" | "workspace">,
  input: {
    provider: ProviderId;
    modelId: string;
    at: IsoDate;
  }
): ModelPricing | undefined {
  return state.modelPricing
    .filter(
      (record) =>
        record.workspaceId === state.workspace.id &&
        record.provider === input.provider &&
        record.modelId === input.modelId &&
        record.effectiveAt <= input.at
    )
    .sort(
      (left, right) =>
        right.effectiveAt.localeCompare(left.effectiveAt) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id)
    )[0];
}

/**
 * Stamps the pricing snapshot resolved as-of the attempt start time and
 * the resulting estimated cost onto a Provider attempt. Mutates in place
 * for use inside a store update.
 */
export function stampAttemptCost(
  state: Pick<AppState, "modelPricing" | "workspace">,
  attempt: ProviderAttempt
): void {
  const pricing = resolvePricingSnapshot(state, {
    provider: attempt.provider,
    modelId: attempt.modelId,
    at: attempt.startedAt
  });
  attempt.pricingId = pricing?.id;
  attempt.estimatedCostMicros = computeAttemptCostMicros(
    attempt.usage,
    pricing
  );
}

export function attemptCost(
  state: Pick<AppState, "modelPricing" | "workspace">,
  attempt: ProviderAttempt
): { currency: string; costMicros: number } | null {
  if (attempt.estimatedCostMicros != null) {
    const pricing = attempt.pricingId
      ? state.modelPricing.find((item) => item.id === attempt.pricingId)
      : undefined;
    return pricing
      ? { currency: pricing.currency, costMicros: attempt.estimatedCostMicros }
      : null;
  }
  const pricing = resolvePricingSnapshot(state, {
    provider: attempt.provider,
    modelId: attempt.modelId,
    at: attempt.startedAt
  });
  const costMicros = computeAttemptCostMicros(attempt.usage, pricing);
  if (pricing === undefined || costMicros === null) return null;
  return { currency: pricing.currency, costMicros };
}

function sortedTotals(entries: Map<string, number>): CostByCurrency[] {
  return [...entries.entries()]
    .map(([currency, costMicros]) => ({ currency, costMicros }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

export function aggregateAttemptCosts(
  state: Pick<AppState, "modelPricing" | "workspace">,
  attempts: ProviderAttempt[]
): AttemptCostAggregate {
  const totals = new Map<string, number>();
  const byPurpose = new Map<string, number>();
  const byModel = new Map<string, number>();
  let pricedAttemptCount = 0;
  let unknownCostAttemptCount = 0;

  for (const attempt of attempts) {
    const cost = attemptCost(state, attempt);
    if (cost === null) {
      unknownCostAttemptCount += 1;
      continue;
    }
    pricedAttemptCount += 1;
    totals.set(cost.currency, (totals.get(cost.currency) ?? 0) + cost.costMicros);
    const purposeKey = `${attempt.purpose}\u0000${cost.currency}`;
    byPurpose.set(purposeKey, (byPurpose.get(purposeKey) ?? 0) + cost.costMicros);
    const modelKey = `${attempt.provider}\u0000${attempt.modelId}\u0000${cost.currency}`;
    byModel.set(modelKey, (byModel.get(modelKey) ?? 0) + cost.costMicros);
  }

  return {
    totals: sortedTotals(totals),
    byPurpose: [...byPurpose.entries()]
      .map(([key, costMicros]) => {
        const [purpose, currency] = key.split("\u0000");
        return {
          purpose: purpose as ProviderAttemptPurpose,
          currency,
          costMicros
        };
      })
      .sort(
        (left, right) =>
          left.purpose.localeCompare(right.purpose) ||
          left.currency.localeCompare(right.currency)
      ),
    byModel: [...byModel.entries()]
      .map(([key, costMicros]) => {
        const [provider, modelId, currency] = key.split("\u0000");
        return {
          provider: provider as ProviderId,
          modelId,
          currency,
          costMicros
        };
      })
      .sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) ||
          left.modelId.localeCompare(right.modelId) ||
          left.currency.localeCompare(right.currency)
      ),
    pricedAttemptCount,
    unknownCostAttemptCount
  };
}
