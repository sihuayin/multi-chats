import { describe, expect, it } from "vitest";
import {
  DiscussionTotalBudgetError,
  evaluateDiscussionBudget
} from "@/server/application/discussion-budget";
import {
  createFixtureDiscussion,
  createFixtureModelPricing,
  createFixtureProviderAttempt,
  createFixtureState
} from "@/server/test-support/fixtures";
import type { AppState, Discussion } from "@/server/domain/types";

function setup(
  discussionOverrides: Partial<Discussion> = {}
): { state: AppState; discussion: Discussion } {
  const state = createFixtureState();
  const discussion = createFixtureDiscussion({
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id
  });
  Object.assign(discussion, discussionOverrides);
  state.discussions.push(discussion);
  return { state, discussion };
}

describe("evaluateDiscussionBudget", () => {
  it("is unbounded when neither Discussion nor Workspace set limits", () => {
    const { state, discussion } = setup();
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.source).toBe("none");
    expect(evaluation.tokens.state).toBe("unbounded");
    expect(evaluation.cost.state).toBe("unbounded");
    expect(evaluation.decision).toBe("proceed");
  });

  it("inherits Workspace defaults when the Discussion has no budget", () => {
    const { state, discussion } = setup();
    state.workspace.discussionBudgetDefaults = {
      maxTotalTokens: 10_000,
      softTotalTokens: 8_000
    };
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.source).toBe("workspace_defaults");
    expect(evaluation.tokens.hard).toBe(10_000);
    expect(evaluation.tokens.soft).toBe(8_000);
  });

  it("tracks used and remaining tokens from Provider attempts", () => {
    const { state, discussion } = setup({
      budget: { maxTotalTokens: 1_000, softTotalTokens: 500 }
    });
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "a1",
        discussionId: discussion.id,
        usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400, source: "provider" }
      })
    );
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.tokens.used).toBe(400);
    expect(evaluation.tokens.remaining).toBe(600);
    expect(evaluation.tokens.state).toBe("ok");
    expect(evaluation.decision).toBe("proceed");
  });

  it("reaches soft when used tokens meet the soft threshold", () => {
    const { state, discussion } = setup({
      budget: { maxTotalTokens: 1_000, softTotalTokens: 400 }
    });
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "a1",
        discussionId: discussion.id,
        usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400, source: "provider" }
      })
    );
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.tokens.state).toBe("soft");
    expect(evaluation.decision).toBe("soft_stop");
  });

  it("rejects the next call when its estimate would exceed the hard token limit", () => {
    const { state, discussion } = setup({
      budget: { maxTotalTokens: 1_000 }
    });
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "a1",
        discussionId: discussion.id,
        usage: { inputTokens: 600, outputTokens: 100, totalTokens: 700, source: "provider" }
      })
    );
    const evaluation = evaluateDiscussionBudget(state, discussion, {
      nextCallTokenEstimate: 400
    });
    expect(evaluation.tokens.state).toBe("hard");
    expect(evaluation.decision).toBe("hard_stop");
  });

  it("sums stamped attempt costs in the budget currency and reports unknown coverage", () => {
    const { state, discussion } = setup({
      budget: {
        maxTotalCostMicros: 1_000_000,
        softTotalCostMicros: 400_000,
        currency: "USD"
      }
    });
    state.modelPricing.push(createFixtureModelPricing({ workspaceId: state.workspace.id }));
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "a1",
        discussionId: discussion.id,
        usage: { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000, source: "provider" },
        pricingId: "pricing-openai-test",
        estimatedCostMicros: 300_000
      }),
      createFixtureProviderAttempt({
        id: "a2",
        discussionId: discussion.id,
        usage: { source: "unknown" },
        estimatedCostMicros: null
      })
    );
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.cost.usedMicros).toBe(300_000);
    expect(evaluation.cost.remainingMicros).toBe(700_000);
    expect(evaluation.cost.unknownCostAttemptCount).toBe(1);
    expect(evaluation.cost.state).toBe("ok");
    expect(evaluation.decision).toBe("proceed");
  });

  it("marks cost unknown when pricing is missing while a cost limit is set", () => {
    const { state, discussion } = setup({
      budget: { maxTotalCostMicros: 1_000_000, currency: "USD" }
    });
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "a1",
        discussionId: discussion.id,
        estimatedCostMicros: null
      })
    );
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.cost.state).toBe("unknown");
    expect(evaluation.cost.unknownCostAttemptCount).toBe(1);
    expect(evaluation.decision).toBe("proceed");
  });

  it("stops hard when stamped costs would exceed the cost limit", () => {
    const { state, discussion } = setup({
      budget: { maxTotalCostMicros: 500_000, currency: "USD" }
    });
    state.modelPricing.push(createFixtureModelPricing({ workspaceId: state.workspace.id }));
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "a1",
        discussionId: discussion.id,
        usage: { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000, source: "provider" },
        pricingId: "pricing-openai-test",
        estimatedCostMicros: 300_000
      }),
      createFixtureProviderAttempt({
        id: "a2",
        discussionId: discussion.id,
        usage: { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000, source: "provider" },
        pricingId: "pricing-openai-test",
        estimatedCostMicros: 300_000
      })
    );
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.cost.state).toBe("hard");
    expect(evaluation.decision).toBe("hard_stop");
  });

  it("ignores attempts from other Discussions", () => {
    const { state, discussion } = setup({
      budget: { maxTotalTokens: 1_000 }
    });
    state.providerAttempts.push(
      createFixtureProviderAttempt({
        id: "a1",
        discussionId: "other-discussion",
        usage: { inputTokens: 900, outputTokens: 900, totalTokens: 1_800, source: "provider" }
      })
    );
    const evaluation = evaluateDiscussionBudget(state, discussion);
    expect(evaluation.tokens.used).toBe(0);
    expect(evaluation.decision).toBe("proceed");
  });

  it("exposes a stable error with details for hard violations", () => {
    const error = new DiscussionTotalBudgetError({
      dimension: "tokens",
      used: 900,
      limit: 1_000,
      nextCallEstimate: 200,
      decision: "hard"
    });
    expect(error.code).toBe("discussion_budget_exhausted");
    expect(error.name).toBe("DiscussionTotalBudgetError");
    expect(error.details.dimension).toBe("tokens");
  });
});
