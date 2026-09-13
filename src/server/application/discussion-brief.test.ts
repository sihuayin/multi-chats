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
        evidence: "Store tests"
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
  it("parses the canonical v1 Brief", () => {
    expect(parseDiscussionBrief(JSON.stringify(brief()))).toEqual(brief());
  });

  it("keeps historical prompt-profile versions readable", () => {
    const historical = {
      ...brief(),
      promptProfileVersion: "discussion-prompts.v2"
    };
    expect(parseDiscussionBrief(JSON.stringify(historical))).toEqual(
      historical
    );
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
      schemaVersion: 1,
      revision: 1
    });
    expect(second.artifact).toMatchObject({
      id: "brief-artifact-2",
      revision: 2,
      previousArtifactId: "brief-artifact-1"
    });
    expect(discussion.latestBriefArtifactId).toBe("brief-artifact-2");
    expect(state.artifacts).toHaveLength(2);
  });
});
