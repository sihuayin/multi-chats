import { describe, expect, it } from "vitest";
import { buildUsageView } from "@/server/application/usage-view";
import type { UsageBreakdownEntry } from "@/lib/usage-view";
import {
  createFixtureModelPricing,
  createFixtureProviderAttempt,
  createFixtureState
} from "@/server/test-support/fixtures";

describe("Usage view", () => {
  const clock = () => new Date("2026-02-10T12:00:00.000Z");

  function pricedState() {
    const state = createFixtureState();
    state.modelPricing.push(createFixtureModelPricing());
    return state;
  }

  it("totals tokens and cost per currency over the default window", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-a",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-b",
        startedAt: "2026-02-08T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.window).toEqual({
      kind: "30d",
      hours: 720,
      since: "2026-01-11T12:00:00.000Z"
    });
    expect(view.attemptCount).toBe(2);
    expect(view.tokens.inputTokens).toBe(2_000_000);
    expect(view.tokens.outputTokens).toBe(200_000);
    expect(view.tokens.totalTokens).toBe(2_200_000);
    expect(view.tokens.source).toBe("provider");
    expect(view.cost.totals).toEqual([
      { currency: "USD", costMicros: 9_000_000 }
    ]);
    expect(view.cost.pricedAttemptCount).toBe(2);
    expect(view.coverage).toEqual({
      unknownUsageAttempts: 0,
      unknownPricingAttempts: 0
    });
    expect(view.empty).toBe(false);
  });

  it("keeps currencies separate and never sums across them", () => {
    const state = pricedState();
    state.modelPricing.push(
      createFixtureModelPricing({
        id: "pricing-anthropic-test",
        provider: "anthropic",
        modelId: "claude-test",
        currency: "EUR"
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-usd",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-eur",
        provider: "anthropic",
        modelId: "claude-test",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.cost.totals).toEqual([
      { currency: "EUR", costMicros: 4_500_000 },
      { currency: "USD", costMicros: 4_500_000 }
    ]);
    expect(view.cost.pricedAttemptCount).toBe(2);
  });

  it("counts attempts with unknown usage and unknown pricing separately", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-no-usage",
        startedAt: "2026-02-09T00:00:00.000Z",
        usage: { source: "unknown" }
      }),
      createFixtureProviderAttempt({
        id: "attempt-no-pricing",
        modelId: "unpriced-model",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.coverage).toEqual({
      unknownUsageAttempts: 1,
      unknownPricingAttempts: 1
    });
    expect(view.cost.totals).toEqual([]);
    expect(view.cost.pricedAttemptCount).toBe(0);
    expect(view.attemptCount).toBe(2);
  });

  it("reports an empty view when the window holds no attempts", () => {
    const state = pricedState();

    const view = buildUsageView(state, { clock });

    expect(view.empty).toBe(true);
    expect(view.attemptCount).toBe(0);
    expect(view.tokens.totalTokens).toBeUndefined();
    expect(view.tokens.source).toBe("unknown");
    expect(view.cost.totals).toEqual([]);
  });

  it("scopes attempts to the window and includes all time on request", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-recent",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-old",
        startedAt: "2025-12-01T00:00:00.000Z"
      })
    );

    const recent = buildUsageView(state, { clock, window: "7d" });
    expect(recent.window).toEqual({
      kind: "7d",
      hours: 168,
      since: "2026-02-03T12:00:00.000Z"
    });
    expect(recent.attemptCount).toBe(1);

    const allTime = buildUsageView(state, { clock, window: "all" });
    expect(allTime.window).toEqual({ kind: "all", hours: null });
    expect(allTime.attemptCount).toBe(2);
  });

  it("breaks spend down by model, most expensive first", () => {
    const state = pricedState();
    state.modelPricing.push(
      createFixtureModelPricing({
        id: "pricing-anthropic-test",
        provider: "anthropic",
        modelId: "claude-test",
        currency: "EUR"
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-usd-1",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-usd-2",
        startedAt: "2026-02-08T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-eur",
        provider: "anthropic",
        modelId: "claude-test",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    // Two currencies in the window, so cost is not comparable and the rows
    // fall back to total tokens: openai 2.2M outranks anthropic 1.1M.
    expect(view.byModel).toEqual([
      {
        provider: "openai",
        modelId: "test-model",
        tokens: expect.objectContaining({ totalTokens: 2_200_000 }),
        costTotals: [{ currency: "USD", costMicros: 9_000_000 }]
      },
      {
        provider: "anthropic",
        modelId: "claude-test",
        tokens: expect.objectContaining({ totalTokens: 1_100_000 }),
        costTotals: [{ currency: "EUR", costMicros: 4_500_000 }]
      }
    ]);
  });

  it("breaks spend down by provider", () => {
    const state = pricedState();
    state.modelPricing.push(
      createFixtureModelPricing({
        id: "pricing-anthropic-test",
        provider: "anthropic",
        modelId: "claude-test",
        currency: "EUR"
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-openai",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-anthropic",
        provider: "anthropic",
        modelId: "claude-test",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    // Costs tie, tokens tie, so the label settles it: "anthropic" first.
    expect(view.byProvider).toEqual([
      {
        provider: "anthropic",
        tokens: expect.objectContaining({ totalTokens: 1_100_000 }),
        costTotals: [{ currency: "EUR", costMicros: 4_500_000 }]
      },
      {
        provider: "openai",
        tokens: expect.objectContaining({ totalTokens: 1_100_000 }),
        costTotals: [{ currency: "USD", costMicros: 4_500_000 }]
      }
    ]);
  });

  it("keeps currencies separate inside a grouped breakdown", () => {
    const state = createFixtureState();
    state.modelPricing.push(
      createFixtureModelPricing({
        id: "pricing-usd",
        currency: "USD",
        effectiveAt: "2026-01-01T00:00:00.000Z"
      }),
      createFixtureModelPricing({
        id: "pricing-eur",
        currency: "EUR",
        effectiveAt: "2026-02-05T00:00:00.000Z"
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-early",
        startedAt: "2026-02-01T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-late",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byModel).toHaveLength(1);
    expect(view.byModel[0].costTotals).toEqual([
      { currency: "EUR", costMicros: 4_500_000 },
      { currency: "USD", costMicros: 4_500_000 }
    ]);
    expect(view.cost.totals).toEqual([
      { currency: "EUR", costMicros: 4_500_000 },
      { currency: "USD", costMicros: 4_500_000 }
    ]);
  });

  it("scopes the grouped breakdowns to the window", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-recent",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-old",
        provider: "anthropic",
        modelId: "claude-test",
        startedAt: "2025-12-01T00:00:00.000Z"
      })
    );

    const recent = buildUsageView(state, { clock, window: "7d" });
    expect(recent.byModel.map((entry) => entry.modelId)).toEqual(["test-model"]);
    expect(recent.byProvider.map((entry) => entry.provider)).toEqual(["openai"]);

    const allTime = buildUsageView(state, { clock, window: "all" });
    expect(
      allTime.byProvider.map((entry) => entry.provider).sort()
    ).toEqual(["anthropic", "openai"]);
  });

  it("reports no grouped breakdowns when the window is empty", () => {
    const state = pricedState();

    const view = buildUsageView(state, { clock });

    expect(view.byModel).toEqual([]);
    expect(view.byProvider).toEqual([]);
  });

  it("keys a model by its provider as well as its model id", () => {
    const state = createFixtureState();
    state.modelPricing.push(
      createFixtureModelPricing({
        id: "pricing-openai-shared",
        provider: "openai",
        modelId: "shared-model"
      }),
      createFixtureModelPricing({
        id: "pricing-anthropic-shared",
        provider: "anthropic",
        modelId: "shared-model"
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-openai-shared",
        provider: "openai",
        modelId: "shared-model",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-anthropic-shared",
        provider: "anthropic",
        modelId: "shared-model",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byModel.map((entry) => [entry.provider, entry.modelId])).toEqual(
      [
        ["anthropic", "shared-model"],
        ["openai", "shared-model"]
      ]
    );
  });

  it("keeps two models of one provider apart", () => {
    const state = createFixtureState();
    state.modelPricing.push(
      createFixtureModelPricing({ id: "pricing-a", modelId: "model-a" }),
      createFixtureModelPricing({ id: "pricing-b", modelId: "model-b" })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-a",
        modelId: "model-a",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-b",
        modelId: "model-b",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byModel.map((entry) => entry.modelId)).toEqual([
      "model-a",
      "model-b"
    ]);
    expect(view.byProvider).toHaveLength(1);
  });

  it("orders a single-currency breakdown by cost, not by tokens", () => {
    const state = createFixtureState();
    state.modelPricing.push(
      createFixtureModelPricing({
        id: "pricing-cheap",
        modelId: "cheap-model",
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 1_000_000
      }),
      createFixtureModelPricing({
        id: "pricing-dear",
        modelId: "dear-model",
        inputMicrosPerMillionTokens: 100_000_000,
        outputMicrosPerMillionTokens: 100_000_000
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-cheap",
        modelId: "cheap-model",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-dear",
        modelId: "dear-model",
        startedAt: "2026-02-09T00:00:00.000Z",
        usage: {
          inputTokens: 100_000,
          outputTokens: 0,
          totalTokens: 100_000,
          source: "provider"
        }
      })
    );

    const view = buildUsageView(state, { clock });

    // One currency, so cost orders the rows: dear-model bills 10,000,000
    // micros against cheap-model's 1,100,000, on a tenth of the tokens.
    expect(view.byModel.map((entry) => entry.modelId)).toEqual([
      "dear-model",
      "cheap-model"
    ]);
  });

  it("reconciles each breakdown with the workspace totals", () => {
    const state = pricedState();
    state.modelPricing.push(
      createFixtureModelPricing({
        id: "pricing-anthropic-test",
        provider: "anthropic",
        modelId: "claude-test",
        currency: "EUR"
      })
    );
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-usd-1",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-usd-2",
        startedAt: "2026-02-08T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-eur",
        provider: "anthropic",
        modelId: "claude-test",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    const costOf = (entries: UsageBreakdownEntry[], currency: string) =>
      entries.reduce(
        (sum, entry) =>
          sum +
          (entry.costTotals.find((total) => total.currency === currency)
            ?.costMicros ?? 0),
        0
      );
    const tokensOf = (entries: UsageBreakdownEntry[]) =>
      entries.reduce((sum, entry) => sum + (entry.tokens.totalTokens ?? 0), 0);

    for (const total of view.cost.totals) {
      expect(costOf(view.byModel, total.currency)).toBe(total.costMicros);
      expect(costOf(view.byProvider, total.currency)).toBe(total.costMicros);
    }
    expect(tokensOf(view.byModel)).toBe(view.tokens.totalTokens);
    expect(tokensOf(view.byProvider)).toBe(view.tokens.totalTokens);
  });
});
