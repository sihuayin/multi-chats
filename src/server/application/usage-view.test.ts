import { describe, expect, it } from "vitest";
import { buildUsageView } from "@/server/application/usage-view";
import type { UsageBreakdownEntry } from "@/lib/usage-view";
import {
  addFixtureTaskRunCorrelation,
  createFixtureDiscussion,
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

    for (const total of view.cost.totals) {
      expect(costOf(view.byModel, total.currency)).toBe(total.costMicros);
      expect(costOf(view.byProvider, total.currency)).toBe(total.costMicros);
    }
    expect(tokensOf(view.byModel)).toBe(view.tokens.totalTokens);
    expect(tokensOf(view.byProvider)).toBe(view.tokens.totalTokens);
  });

  it("groups spend by Discussion and carries its budget", () => {
    const state = pricedState();
    const discussion = createFixtureDiscussion();
    discussion.budget = {
      maxTotalTokens: 10_000_000,
      softTotalTokens: 1_000_000,
      maxTotalCostMicros: 1_000_000,
      currency: "USD"
    };
    state.discussions.push(discussion);
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-turn",
        discussionId: discussion.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byDiscussion).toHaveLength(1);
    expect(view.byDiscussion[0]).toMatchObject({
      discussionId: discussion.id,
      conversationId: discussion.conversationId,
      title: discussion.title,
      tokens: expect.objectContaining({ totalTokens: 1_100_000 }),
      costTotals: [{ currency: "USD", costMicros: 4_500_000 }],
      budget: {
        source: "discussion",
        tokens: {
          used: 1_100_000,
          soft: 1_000_000,
          hard: 10_000_000,
          unknownAttempts: 0,
          state: "soft"
        },
        cost: {
          usedMicros: 4_500_000,
          hardMicros: 1_000_000,
          unknownAttempts: 0,
          state: "hard",
          currency: "USD"
        }
      }
    });
  });

  it("renders a Discussion with no budget without a budget indication", () => {
    const state = pricedState();
    const discussion = createFixtureDiscussion();
    state.discussions.push(discussion);
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-turn",
        discussionId: discussion.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byDiscussion[0].budget).toBeNull();
  });

  it("resolves a Discussion budget from workspace defaults", () => {
    const state = pricedState();
    state.workspace.discussionBudgetDefaults = {
      maxTotalTokens: 10_000_000,
      currency: "USD"
    };
    const discussion = createFixtureDiscussion();
    state.discussions.push(discussion);
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-turn",
        discussionId: discussion.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byDiscussion[0].budget).toMatchObject({
      source: "workspace_defaults",
      tokens: { used: 1_100_000, hard: 10_000_000, state: "ok" }
    });
  });

  it("keeps row spend windowed while the budget stays lifetime", () => {
    const state = pricedState();
    const discussion = createFixtureDiscussion();
    discussion.budget = { maxTotalTokens: 10_000_000, currency: "USD" };
    state.discussions.push(discussion);
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-in-window",
        discussionId: discussion.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-before-window",
        discussionId: discussion.id,
        startedAt: "2026-01-01T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "7d" });

    expect(view.byDiscussion).toHaveLength(1);
    // The row's spend is the window's; the budget counts the whole lifetime.
    expect(view.byDiscussion[0].tokens.totalTokens).toBe(1_100_000);
    expect(view.byDiscussion[0].budget?.tokens.used).toBe(2_200_000);
  });

  it("rolls Discussion spend, including re-ranking, into its Conversation", () => {
    const state = pricedState();
    const discussion = createFixtureDiscussion();
    state.discussions.push(discussion);
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-turn",
        discussionId: discussion.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      // Carries no Run: only its Discussion connects it to a Conversation.
      createFixtureProviderAttempt({
        id: "attempt-rerank",
        discussionId: discussion.id,
        purpose: "discussion_rerank",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byConversation).toHaveLength(1);
    expect(view.byConversation[0]).toMatchObject({
      conversationId: discussion.conversationId,
      title: "Launch planning",
      tokens: expect.objectContaining({ totalTokens: 2_200_000 }),
      costTotals: [{ currency: "USD", costMicros: 9_000_000 }]
    });
  });

  it("attributes a conversation Run's spend through its Run", () => {
    const state = pricedState();
    const { run } = addFixtureTaskRunCorrelation(state);
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-chat",
        runId: run.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byConversation).toHaveLength(1);
    expect(view.byConversation[0].conversationId).toBe(run.conversationId);
    expect(view.byConversation[0].tokens.totalTokens).toBe(1_100_000);
  });

  it("keeps separate Conversations apart", () => {
    const state = pricedState();
    const { run } = addFixtureTaskRunCorrelation(state);
    const other = {
      ...state.conversations[0],
      id: "30000000-0000-4000-8000-000000000002",
      title: "Second planning"
    };
    state.conversations.push(other);
    state.runs.push({ ...run, id: "run-other", conversationId: other.id });
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-first",
        runId: run.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-second",
        runId: "run-other",
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    expect(view.byConversation.map((entry) => entry.conversationId)).toEqual([
      "30000000-0000-4000-8000-000000000001",
      "30000000-0000-4000-8000-000000000002"
    ]);
  });

  it("reconciles the Discussion and Conversation breakdowns", () => {
    const state = pricedState();
    const discussion = createFixtureDiscussion();
    state.discussions.push(discussion);
    const { run } = addFixtureTaskRunCorrelation(state);
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-turn",
        discussionId: discussion.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-rerank",
        discussionId: discussion.id,
        purpose: "discussion_rerank",
        startedAt: "2026-02-09T00:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-chat",
        runId: run.id,
        startedAt: "2026-02-09T00:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock });

    // Every attempt resolves to a Conversation, so that roll-up is complete.
    for (const total of view.cost.totals) {
      expect(costOf(view.byConversation, total.currency)).toBe(total.costMicros);
    }
    expect(tokensOf(view.byConversation)).toBe(view.tokens.totalTokens);

    // The Discussion breakdown covers only the Discussion-scoped attempts.
    expect(tokensOf(view.byDiscussion)).toBe(2_200_000);
  });
  it("buckets the series by UTC day", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-morning",
        startedAt: "2026-02-09T01:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-night",
        startedAt: "2026-02-09T23:30:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-previous",
        startedAt: "2026-02-08T12:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "7d" });
    const byDay = new Map(view.series.map((point) => [point.day, point]));

    expect(byDay.get("2026-02-09")?.tokens.totalTokens).toBe(2_200_000);
    expect(byDay.get("2026-02-09")?.costTotals).toEqual([
      { currency: "USD", costMicros: 9_000_000 }
    ]);
    expect(byDay.get("2026-02-08")?.tokens.totalTokens).toBe(1_100_000);
  });

  it("carries spend-free days so gaps cannot distort the series", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-only",
        startedAt: "2026-02-09T01:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "7d" });

    expect(view.series.map((point) => point.day)).toEqual([
      "2026-02-03",
      "2026-02-04",
      "2026-02-05",
      "2026-02-06",
      "2026-02-07",
      "2026-02-08",
      "2026-02-09",
      "2026-02-10"
    ]);
    const quiet = view.series.find((point) => point.day === "2026-02-05");
    expect(quiet?.tokens.totalTokens).toBeUndefined();
    expect(quiet?.costTotals).toEqual([]);
  });

  it("spans from the window's first day through its last", () => {
    const state = pricedState();

    const week = buildUsageView(state, { clock, window: "7d" });
    expect(week.series[0].day).toBe("2026-02-03");
    expect(week.series.at(-1)?.day).toBe("2026-02-10");

    const month = buildUsageView(state, { clock, window: "30d" });
    expect(month.series[0].day).toBe("2026-01-11");
    expect(month.series.at(-1)?.day).toBe("2026-02-10");
  });

  it("starts an all-time series at the earliest attempt", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-oldest",
        startedAt: "2026-01-15T08:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "all" });

    expect(view.series[0].day).toBe("2026-01-15");
    expect(view.series.at(-1)?.day).toBe("2026-02-10");
  });

  it("reports a single day for an empty all-time series", () => {
    const view = buildUsageView(pricedState(), { clock, window: "all" });

    expect(view.series.map((point) => point.day)).toEqual(["2026-02-10"]);
  });

  it("reconciles the series with the workspace totals", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-a",
        startedAt: "2026-02-09T01:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-b",
        startedAt: "2026-02-01T01:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-c",
        startedAt: "2026-01-20T01:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "all" });

    for (const total of view.cost.totals) {
      expect(costOf(view.series, total.currency)).toBe(total.costMicros);
    }
    expect(tokensOf(view.series)).toBe(view.tokens.totalTokens);
  });

  it("omits attempts that fall outside the window from the series", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-in-window",
        startedAt: "2026-02-09T01:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-before-window",
        startedAt: "2025-12-01T01:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "7d" });

    // The series opens on the window's own first day and accounts for
    // exactly the windowed spend; the earlier attempt is in neither.
    expect(view.series[0].day).toBe("2026-02-03");
    expect(view.series.some((point) => point.day === "2025-12-01")).toBe(false);
    expect(view.tokens.totalTokens).toBe(1_100_000);
    expect(tokensOf(view.series)).toBe(view.tokens.totalTokens);
  });

  it("marks the buckets the window cuts through as partial", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt",
        startedAt: "2026-02-09T01:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "7d" });
    const byDay = new Map(view.series.map((point) => [point.day, point]));

    // The 7d window opens at 12:00 on the 3rd, and the clock is 12:00 on
    // the 10th, so both ends cover less than a whole day.
    expect(byDay.get("2026-02-03")?.partial).toBe(true);
    expect(byDay.get("2026-02-10")?.partial).toBe(true);
    expect(byDay.get("2026-02-05")?.partial).toBe(false);
  });

  it("does not mark an all-time series' first bucket as partial", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt",
        startedAt: "2026-01-15T08:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "all" });

    // All time has no lower bound, so only today is cut short.
    expect(view.series[0].partial).toBe(false);
    expect(view.series.at(-1)?.partial).toBe(true);
  });

  it("counts the attempts behind each day", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-one",
        startedAt: "2026-02-09T01:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-two",
        startedAt: "2026-02-09T02:00:00.000Z"
      }),
      // Unknown usage: no tokens, but the day is not silent.
      createFixtureProviderAttempt({
        id: "attempt-unmeasured",
        startedAt: "2026-02-07T01:00:00.000Z",
        usage: { source: "unknown" }
      })
    );

    const view = buildUsageView(state, { clock, window: "7d" });
    const byDay = new Map(view.series.map((point) => [point.day, point]));

    expect(byDay.get("2026-02-09")?.attemptCount).toBe(2);
    const unmeasured = byDay.get("2026-02-07");
    expect(unmeasured?.attemptCount).toBe(1);
    expect(unmeasured?.tokens.totalTokens).toBeUndefined();
  });

  it("keeps an attempt dated after the clock in the series", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-in-window",
        startedAt: "2026-02-09T01:00:00.000Z"
      }),
      // Ahead of the clock, so it still counts in the totals and the series
      // has to cover its day rather than stop at today.
      createFixtureProviderAttempt({
        id: "attempt-ahead-of-clock",
        startedAt: "2030-01-01T01:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "all" });

    expect(view.series.at(-1)?.day).toBe("2030-01-01");
    expect(view.tokens.totalTokens).toBe(2_200_000);
    expect(tokensOf(view.series)).toBe(view.tokens.totalTokens);
  });

  it("excludes an attempt whose start time cannot be parsed", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-valid",
        startedAt: "2026-02-09T01:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-unparseable",
        startedAt: "not-a-date"
      })
    );

    // Must neither throw on the unbounded window nor let the totals and the
    // series disagree about what is in scope.
    const view = buildUsageView(state, { clock, window: "all" });

    expect(view.attemptCount).toBe(1);
    expect(view.tokens.totalTokens).toBe(1_100_000);
    expect(tokensOf(view.series)).toBe(view.tokens.totalTokens);
  });

  it("excludes an out-of-window attempt under the 30-day window too", () => {
    const state = pricedState();
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "attempt-in-window",
        startedAt: "2026-02-09T01:00:00.000Z"
      }),
      createFixtureProviderAttempt({
        id: "attempt-before-window",
        startedAt: "2025-12-01T01:00:00.000Z"
      })
    );

    const view = buildUsageView(state, { clock, window: "30d" });

    expect(view.series[0].day).toBe("2026-01-11");
    expect(view.series.some((point) => point.day === "2025-12-01")).toBe(false);
    expect(tokensOf(view.series)).toBe(view.tokens.totalTokens);
  });

});
