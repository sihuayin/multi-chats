import { describe, expect, it } from "vitest";
import { buildDiscussionView } from "@/server/application/discussion-view";
import {
  createFixtureDiscussion,
  createFixtureModelPricing,
  createFixtureProviderAttempt,
  createFixtureState
} from "@/server/test-support/fixtures";
import type { ProviderAttempt } from "@/server/domain/types";

function attempt(
  overrides: Partial<ProviderAttempt> = {}
): ProviderAttempt {
  return createFixtureProviderAttempt({
    purpose: "discussion_turn",
    usage: {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      source: "provider"
    },
    ...overrides
  });
}

describe("buildDiscussionView cost reporting", () => {
  it("exposes total and dimensioned cost with unknown coverage", () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    state.discussions.push(discussion);
    state.modelPricing.push(
      createFixtureModelPricing({ workspaceId: state.workspace.id })
    );
    state.providerAttempts.push(
      attempt({ id: "a1", discussionId: discussion.id }),
      attempt({
        id: "a2",
        discussionId: discussion.id,
        purpose: "discussion_synthesis",
        usage: { source: "unknown" }
      }),
      attempt({ id: "a3", discussionId: "other-discussion" })
    );

    const view = buildDiscussionView(state, discussion.id);

    expect(view.cost.totals).toEqual([
      { currency: "USD", costMicros: 450 }
    ]);
    expect(view.cost.byPurpose).toEqual([
      { purpose: "discussion_turn", currency: "USD", costMicros: 450 }
    ]);
    expect(view.cost.byModel).toEqual([
      {
        provider: "openai",
        modelId: "test-model",
        currency: "USD",
        costMicros: 450
      }
    ]);
    expect(view.cost.pricedAttemptCount).toBe(1);
    expect(view.cost.unknownCostAttemptCount).toBe(1);
  });
});
