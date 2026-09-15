import { describe, expect, it } from "vitest";
import {
  createDiscussionBriefRevision,
  DISCUSSION_BRIEF_SCHEMA_VERSION,
  parseDiscussionBrief
} from "@/server/application/discussion-brief";
import { DISCUSSION_PROMPT_PROFILE_VERSION } from "@/server/application/discussion-prompts";
import {
  createFixtureDiscussion,
  createFixtureState
} from "@/server/test-support/fixtures";

function brief() {
  return {
    schemaVersion: DISCUSSION_BRIEF_SCHEMA_VERSION,
    promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
    discussionId: "discussion-1",
    mode: "solution",
    title: "Choose a persistence model",
    problem: {
      statement: "Discussions need durable state.",
      goals: ["Preserve history"],
      nonGoals: ["Cross-workspace memory"]
    },
    context: "The workspace already stores JSON state.",
    facts: [
      {
        statement: "SQLite and PostgreSQL are supported.",
        kind: "fact",
        evidenceIds: ["external:https://example.com/store-tests"]
      }
    ],
    constraints: [
      {
        statement: "Development uses SQLite.",
        kind: "environment"
      }
    ],
    assumptions: ["Single workspace remains in scope."],
    disagreements: [
      {
        topic: "Migration timing",
        positions: [
          {
            employeeId: "employee-1",
            position: "Migrate incrementally."
          }
        ]
      }
    ],
    minorityPositions: ["PostgreSQL may become mandatory later."],
    options: [
      {
        id: "state-document",
        title: "Keep the state document",
        summary: "Continue using the shared JSON aggregate.",
        benefits: ["Reuses tested storage"],
        costs: ["Less relational querying"],
        risks: ["Large documents need care"]
      }
    ],
    recommendation: {
      optionId: "state-document",
      rationale: "It has the smallest migration surface.",
      confidence: "high"
    },
    actions: [
      {
        title: "Add validation",
        description: "Validate state during migration.",
        priority: "high"
      }
    ],
    openQuestions: ["When should retention limits apply?"]
  };
}

describe("Discussion Brief", () => {
  it("parses the canonical v2 Brief", () => {
    expect(parseDiscussionBrief(JSON.stringify(brief()))).toEqual(brief());
  });

  it("keeps historical prompt-profile versions readable", () => {
    const historicalWithMinority = {
      ...brief(),
      schemaVersion: 1,
      promptProfileVersion: "discussion-prompts.v1",
      facts: [
        {
          statement: "SQLite and PostgreSQL are supported.",
          evidence: "Store tests"
        }
      ]
    };
    const { minorityPositions, ...historical } = historicalWithMinority;
    void minorityPositions;
    expect(parseDiscussionBrief(JSON.stringify(historical))).toEqual(
      historical
    );
  });

  it("keeps a v2 prompt-profile Brief revision loadable after the v3 bump", () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    const revision = {
      ...brief(),
      promptProfileVersion: "discussion-prompts.v2",
      discussionId: discussion.id
    };

    const { artifact } = createDiscussionBriefRevision(
      state,
      discussion,
      JSON.stringify(revision),
      {
        id: () => "brief-artifact-v2",
        now: () => "2026-01-01T00:00:00.000Z"
      }
    );

    expect(artifact).toMatchObject({
      kind: "discussion_brief",
      schemaVersion: 2,
      revision: 1
    });
  });

  it("rejects duplicate option IDs", () => {
    const value = brief();
    value.options.push(structuredClone(value.options[0]));
    expect(() => parseDiscussionBrief(JSON.stringify(value))).toThrow(
      "Discussion Brief option IDs must be unique"
    );
  });

  it("requires recommendation to reference an option", () => {
    const value = brief();
    value.recommendation.optionId = "missing";
    expect(() => parseDiscussionBrief(JSON.stringify(value))).toThrow(
      "Discussion Brief recommendation must reference an option"
    );
  });

  it("creates immutable linked Brief revisions", () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    const revision = {
      ...brief(),
      discussionId: discussion.id
    };

    const first = createDiscussionBriefRevision(
      state,
      discussion,
      JSON.stringify(revision),
      {
        id: () => "brief-artifact-1",
        now: () => "2026-01-01T00:00:00.000Z"
      }
    );
    const second = createDiscussionBriefRevision(
      state,
      discussion,
      JSON.stringify(revision),
      {
        id: () => "brief-artifact-2",
        now: () => "2026-01-01T00:01:00.000Z"
      }
    );

    expect(first.artifact).toMatchObject({
      id: "brief-artifact-1",
      ownerType: "discussion",
      ownerId: discussion.id,
      type: "json",
      kind: "discussion_brief",
      schemaVersion: 2,
      revision: 1
    });
    expect(second.artifact).toMatchObject({
      id: "brief-artifact-2",
      revision: 2,
      previousArtifactId: "brief-artifact-1"
    });
    expect(state.evidenceReferences).toContainEqual(
      expect.objectContaining({
        kind: "external_source",
        sourceId: "https://example.com/store-tests"
      })
    );
    expect(JSON.parse(second.artifact.content)).toMatchObject({
      minorityPositions: [
        "PostgreSQL may become mandatory later."
      ]
    });
    expect(discussion.latestBriefArtifactId).toBe("brief-artifact-2");
    expect(state.artifacts).toHaveLength(2);
  });

  it("rejects promoting an inference Turn into a Brief fact", () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    state.discussions.push(discussion);
    const turn = discussion.rounds[0].turns[0];
    turn.payload = {
      summary: "Inference only",
      claims: [
        {
          statement: "A possible explanation.",
          kind: "inference",
          confidence: "medium"
        }
      ],
      assumptions: [],
      risks: [],
      openQuestions: []
    };
    const value = {
      ...brief(),
      discussionId: discussion.id,
      facts: [
        {
          statement: "A possible explanation is established fact.",
          kind: "fact" as const,
          evidenceIds: [`turn:${turn.id}`]
        }
      ]
    };

    expect(() =>
      createDiscussionBriefRevision(
        state,
        discussion,
        JSON.stringify(value)
      )
    ).toThrow("Inference cannot be promoted");
  });
});
