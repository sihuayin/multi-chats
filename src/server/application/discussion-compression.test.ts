import { describe, expect, it } from "vitest";
import {
  buildExtractiveDigest,
  compressionMatches,
  compressionSource
} from "@/server/application/discussion-compression";
import { createFixtureDiscussion } from "@/server/test-support/fixtures";

describe("Discussion compression", () => {
  it("hashes the source span and invalidates on source changes", () => {
    const discussion = createFixtureDiscussion();
    const round = discussion.rounds[0];
    const first = compressionSource([round]);
    const record = {
      id: "compression",
      workspaceId: discussion.workspaceId,
      discussionId: discussion.id,
      status: "completed" as const,
      sourceRoundIds: first.sourceRoundIds,
      sourceTurnIds: first.sourceTurnIds,
      evidenceIds: first.evidenceIds,
      content: "summary",
      unresolvedQuestions: [],
      minorityPositions: [],
      schemaVersion: 1,
      promptProfileVersion: "discussion-prompts.v3",
      compressionProfileVersion: "discussion-compression.v1",
      contentHash: "content",
      sourceSpanHash: first.sourceSpanHash,
      strategy: "extractive" as const,
      createdAt: discussion.createdAt,
      updatedAt: discussion.updatedAt
    };
    expect(compressionMatches(record, first)).toBe(true);

    round.turns[0].payload!.summary = "changed";
    const changed = compressionSource([round]);
    expect(changed.sourceSpanHash).not.toBe(first.sourceSpanHash);
    expect(compressionMatches(record, changed)).toBe(false);
    expect(
      compressionMatches(record, first, {
        provider: "openai",
        modelId: "other-model"
      })
    ).toBe(false);
    expect(
      compressionMatches(
        { ...record, promptProfileVersion: "discussion-prompts.v1" },
        first
      )
    ).toBe(false);
  });

  it("uses extractive summaries without inventing claims", () => {
    const discussion = createFixtureDiscussion();
    discussion.rounds[0].turns[0].payload = {
      summary: "Analyst summary",
      claims: [
        {
          statement: "Supported fact",
          kind: "fact",
          evidenceIds: ["turn:source"],
          confidence: "high"
        },
        {
          statement: "Possible explanation",
          kind: "inference",
          confidence: "medium"
        }
      ],
      assumptions: [],
      risks: [],
      openQuestions: ["What remains unknown?"]
    };

    const digest = buildExtractiveDigest([discussion.rounds[0]]);

    expect(digest).toContain("[fact] Supported fact");
    expect(digest).toContain("[inference] Possible explanation");
    expect(digest).toContain("unresolved: What remains unknown?");
    expect(digest).not.toContain("invented");
  });
});
