import { describe, expect, it } from "vitest";
import {
  aggregateAttemptCosts,
  computeAttemptCostMicros,
  resolvePricingSnapshot
} from "@/server/application/model-pricing";
import {
  createFixtureModelPricing,
  createFixtureProviderAttempt,
  createFixtureState
} from "@/server/test-support/fixtures";
import type {
  ModelPricing,
  ModelUsage,
  ProviderAttempt
} from "@/server/domain/types";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function pricing(
  overrides: Partial<ModelPricing> = {}
): ModelPricing {
  return createFixtureModelPricing({ id: "pricing-1", ...overrides });
}

function usage(overrides: Partial<ModelUsage> = {}): ModelUsage {
  return {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    totalTokens: 1_100_000,
    source: "provider",
    ...overrides
  };
}

function attempt(
  overrides: Partial<ProviderAttempt> = {}
): ProviderAttempt {
  return createFixtureProviderAttempt(overrides);
}

describe("computeAttemptCostMicros", () => {
  it("computes integer micros from input and output rates", () => {
    expect(computeAttemptCostMicros(usage(), pricing())).toBe(4_500_000);
  });

  it("bills cached input tokens at the cached rate", () => {
    const cost = computeAttemptCostMicros(
      usage({ inputTokens: 1_000_000, cachedInputTokens: 400_000 }),
      pricing({ cachedInputMicrosPerMillionTokens: 300_000 })
    );
    // 600k input * 3.0 + 400k cached * 0.3 + 100k output * 15.0 (micros)
    expect(cost).toBe(1_800_000 + 120_000 + 1_500_000);
  });

  it("bills cached tokens at the input rate when no cached rate exists", () => {
    const cost = computeAttemptCostMicros(
      usage({ inputTokens: 1_000_000, cachedInputTokens: 400_000 }),
      pricing()
    );
    expect(cost).toBe(3_000_000 + 1_500_000);
  });

  it("rounds half up deterministically without floating point drift", () => {
    // 1 token at 1 micro per million => 0.000001 micros, rounds to 0
    expect(
      computeAttemptCostMicros(
        usage({ inputTokens: 1, outputTokens: 0, totalTokens: 1 }),
        pricing({ inputMicrosPerMillionTokens: 1 })
      )
    ).toBe(0);
    // exactly 0.5 micros rounds up to 1
    expect(
      computeAttemptCostMicros(
        usage({ inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000 }),
        pricing({ inputMicrosPerMillionTokens: 1 })
      )
    ).toBe(1);
    expect(
      computeAttemptCostMicros(
        usage({ inputTokens: 1_500_000, outputTokens: 0, totalTokens: 1_500_000 }),
        pricing({ inputMicrosPerMillionTokens: 1 })
      )
    ).toBe(2);
  });

  it("returns null for unknown usage rather than zero", () => {
    expect(
      computeAttemptCostMicros({ source: "unknown" }, pricing())
    ).toBeNull();
    expect(computeAttemptCostMicros(usage(), undefined)).toBeNull();
  });

  it("treats estimated usage as computable but keeps the source visible", () => {
    expect(
      computeAttemptCostMicros(usage({ source: "estimated" }), pricing())
    ).toBe(4_500_000);
  });
});

describe("resolvePricingSnapshot", () => {
  it("selects the latest record effective at the attempt time", () => {
    const state = createFixtureState();
    const older = pricing({ id: "pricing-old", version: "2026-01" });
    const newer = pricing({
      id: "pricing-new",
      version: "2026-03",
      effectiveAt: "2026-03-01T00:00:00.000Z",
      inputMicrosPerMillionTokens: 6_000_000
    });
    state.modelPricing.push(older, newer);

    expect(
      resolvePricingSnapshot(state, {
        provider: "openai",
        modelId: "test-model",
        at: "2026-02-01T00:00:00.000Z"
      })?.id
    ).toBe("pricing-old");
    expect(
      resolvePricingSnapshot(state, {
        provider: "openai",
        modelId: "test-model",
        at: "2026-04-01T00:00:00.000Z"
      })?.id
    ).toBe("pricing-new");
  });

  it("returns undefined when no pricing matches provider, model, or workspace", () => {
    const state = createFixtureState();
    state.modelPricing.push(pricing());
    expect(
      resolvePricingSnapshot(state, {
        provider: "openai",
        modelId: "other-model",
        at: "2026-02-01T00:00:00.000Z"
      })
    ).toBeUndefined();
    expect(
      resolvePricingSnapshot(
        { ...state, workspace: { ...state.workspace, id: "other" } },
        {
          provider: "openai",
          modelId: "test-model",
          at: "2026-02-01T00:00:00.000Z"
        }
      )
    ).toBeUndefined();
  });
});

describe("aggregateAttemptCosts", () => {
  it("sums succeeded, failed, retried, and fallback attempts once each", () => {
    const state = createFixtureState();
    state.modelPricing.push(pricing());
    const attempts = [
      attempt({ id: "a1" }),
      attempt({
        id: "a2",
        status: "failed",
        usage: usage({ inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 })
      }),
      attempt({ id: "a3", attempt: 2 }),
      attempt({ id: "a4", targetOrder: 1, provider: "anthropic", modelId: "fallback-model" })
    ];
    // a4 has no pricing record for anthropic/fallback-model => unknown cost
    const aggregate = aggregateAttemptCosts(state, attempts);
    // a1 + a3: 2 * 4.5 USD-micros; a2: 0.3 USD-micros
    expect(aggregate.totals).toEqual([
      { currency: "USD", costMicros: 9_300_000 }
    ]);
    expect(aggregate.unknownCostAttemptCount).toBe(1);
    expect(aggregate.pricedAttemptCount).toBe(3);
  });

  it("keeps currencies separate and reports dimensions", () => {
    const state = createFixtureState();
    state.modelPricing.push(
      pricing(),
      pricing({
        id: "pricing-eur",
        provider: "anthropic",
        modelId: "claude-model",
        currency: "EUR",
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000
      })
    );
    const attempts = [
      attempt({ id: "a1", purpose: "discussion_turn" }),
      attempt({
        id: "a2",
        provider: "anthropic",
        modelId: "claude-model",
        purpose: "discussion_synthesis",
        usage: usage({ inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 })
      })
    ];
    const aggregate = aggregateAttemptCosts(state, attempts);
    expect(aggregate.totals).toEqual([
      { currency: "EUR", costMicros: 1_000_000 },
      { currency: "USD", costMicros: 4_500_000 }
    ]);
    expect(aggregate.byPurpose).toEqual([
      { purpose: "discussion_synthesis", currency: "EUR", costMicros: 1_000_000 },
      { purpose: "discussion_turn", currency: "USD", costMicros: 4_500_000 }
    ]);
    expect(aggregate.byModel).toEqual([
      { provider: "anthropic", modelId: "claude-model", currency: "EUR", costMicros: 1_000_000 },
      { provider: "openai", modelId: "test-model", currency: "USD", costMicros: 4_500_000 }
    ]);
    expect(aggregate.unknownCostAttemptCount).toBe(0);
  });

  it("does not recompute historical costs after prices change", () => {
    const state = createFixtureState();
    state.modelPricing.push(
      pricing(),
      pricing({
        id: "pricing-new",
        effectiveAt: "2026-03-01T00:00:00.000Z",
        inputMicrosPerMillionTokens: 30_000_000,
        outputMicrosPerMillionTokens: 150_000_000
      })
    );
    const historical = attempt({
      id: "a1",
      startedAt: "2026-02-01T00:00:00.000Z",
      // Stored at execution time under the old rate card; recomputation
      // with today's pricing would yield a different number.
      estimatedCostMicros: 999,
      pricingId: "pricing-1"
    });
    const aggregate = aggregateAttemptCosts(state, [historical]);
    expect(aggregate.totals).toEqual([
      { currency: "USD", costMicros: 999 }
    ]);
  });
});
