import { describe, expect, it } from "vitest";
import { buildUsageView } from "@/server/application/usage-view";
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
});
