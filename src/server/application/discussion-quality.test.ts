import { describe, expect, it } from "vitest";
import {
  DISCUSSION_QUALITY_CORPUS,
  DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT,
  DISCUSSION_QUALITY_RUBRIC_VERSION,
  evaluateDiscussionQuality,
  evaluateDiscussionQualityReport,
  evaluateQualityGate,
  evaluateQualityRuns,
  redactQualityEvidence,
  validateQualityResults,
  type DiscussionQualitySample
} from "@/server/application/discussion-quality";
import { parseDiscussionBrief } from "@/server/application/discussion-brief";
import {
  createFixtureBrief,
  createFixtureDiscussion,
  createFixtureState
} from "@/server/test-support/fixtures";

function sample(
  overrides: Partial<DiscussionQualitySample> = {}
): DiscussionQualitySample {
  const state = createFixtureState();
  const discussion = createFixtureDiscussion({
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id
  });
  discussion.participants = [
    "analyst",
    "researcher",
    "skeptic",
    "designer",
    "facilitator"
  ].map((role, index) => ({
    id: `participant-${role}`,
    employeeId: `employee-${role}`,
    role: role as DiscussionQualitySample["discussion"]["participants"][number]["role"],
    objective: `${role} objective`,
    order: index + 1
  }));
  discussion.facilitatorParticipantId = "participant-facilitator";
  discussion.rounds = [
    {
      id: "round-1-positions",
      roundNumber: 1,
      phase: "positions",
      status: "completed",
      participantSnapshot: structuredClone(discussion.participants),
      activeParticipantIds: discussion.participants.map((item) => item.id),
      turns: discussion.participants.map((participant, index) => ({
        id: `position-${index}`,
        employeeId: participant.employeeId,
        role: participant.role,
        order: participant.order,
        status: "completed" as const,
        payload: {
          summary: `${participant.role} position`,
          claims: [
            {
              statement: `${participant.role} supported claim`,
              kind: "fact" as const,
              evidenceIds: ["external:https://example.com/corpus"],
              confidence: "high" as const
            }
          ],
          assumptions: [],
          risks: [],
          openQuestions: []
        },
        createdAt: "2026-01-01T00:00:00.000Z"
      })),
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "round-1-cross",
      roundNumber: 1,
      phase: "cross_response",
      status: "completed",
      participantSnapshot: structuredClone(discussion.participants),
      activeParticipantIds: discussion.participants.map((item) => item.id),
      turns: discussion.participants.map((participant, index) => ({
        id: `cross-${index}`,
        employeeId: participant.employeeId,
        role: participant.role,
        order: participant.order,
        status: "completed" as const,
        payload: {
          summary: `${participant.role} cross-response`,
          claims: [],
          assumptions: [],
          risks: [],
          openQuestions: ["What should be validated next?"],
          agreements: ["The evidence is relevant."],
          disagreements: ["The migration risk is material."],
          corrections: ["The first estimate was too optimistic."]
        },
        createdAt: "2026-01-01T00:00:00.000Z"
      })),
      createdAt: "2026-01-01T00:00:00.000Z"
    }
  ];
  state.evidenceReferences.push({
    id: "evidence-corpus",
    workspaceId: state.workspace.id,
    kind: "external_source",
    sourceId: "https://example.com/corpus",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  const brief = {
    ...createFixtureBrief(discussion.id),
    title: discussion.title,
    facts: discussion.participants.map((participant) => ({
      statement: `${participant.role} supported claim`,
      kind: "fact" as const,
      evidenceIds: ["external:https://example.com/corpus"]
    })),
    disagreements: [
      {
        topic: "migration risk",
        positions: [
          { employeeId: "employee-skeptic", position: "Material" }
        ]
      }
    ],
    minorityPositions: ["The migration risk is material."],
    actions: [
      {
        title: "Validate migration",
        description: "Run the migration fixture before release.",
        suggestedOwner: "employee-researcher",
        priority: "high" as const
      }
    ]
  };
  return {
    scenarioId: "solution-architecture",
    state,
    discussion,
    brief,
    ...overrides
  };
}

describe("Discussion quality evaluation", () => {
  it("has a versioned corpus for all four Discussion modes", () => {
    expect(DISCUSSION_QUALITY_RUBRIC_VERSION).toBe("discussion-quality.v1");
    expect(DISCUSSION_QUALITY_CORPUS.map((item) => item.mode)).toEqual([
      "requirements",
      "problem",
      "solution",
      "review"
    ]);
  });

  it("scores role differentiation, evidence, challenge, disagreement, actionability, and fidelity", () => {
    const result = evaluateDiscussionQuality(sample());

    expect(result.hardFailures).toEqual([]);
    expect(result.scores.roleDifferentiation).toBe(1);
    expect(result.scores.evidenceValidity).toBe(1);
    expect(result.scores.challengeAndCorrection).toBe(1);
    expect(result.scores.unresolvedDisagreement).toBe(1);
    expect(result.scores.actionability).toBe(1);
    expect(result.scores.briefFidelity).toBe(1);
  });

  it("reports unsupported facts and missing synthesis as hard regressions", () => {
    const input = sample();
    input.brief = undefined;
    input.discussion.rounds[0].turns[0].payload!.claims[0].evidenceIds = [
      "external:https://example.com/missing"
    ];

    const result = evaluateDiscussionQuality(input);

    expect(result.hardFailures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining([
        "invalid_evidence",
        "unsupported_fact",
        "missing_brief"
      ])
    );
  });

  it("aggregates repeats with variance instead of comparing prose snapshots", () => {
    const first = evaluateDiscussionQuality(sample());
    const secondInput = sample();
    secondInput.discussion.rounds[1].turns[0].payload!.disagreements = [];
    const second = evaluateDiscussionQuality(secondInput);
    const aggregate = evaluateQualityRuns([[first], [second]]);

    expect(aggregate.repeatCount).toBe(2);
    expect(aggregate.dimensions.challengeAndCorrection.variance).toBeGreaterThan(0);
    expect(aggregate.trendWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dimension: "challengeAndCorrection" })
      ])
    );
  });

  it("redacts prompts, responses, credentials, and sensitive evidence", () => {
    const redacted = redactQualityEvidence({
      prompt: "private launch plan",
      response: "Authorization: Bearer secret-token",
      credential: "sk-live-secret",
      evidence: "user@example.com says private thing"
    });

    expect(JSON.stringify(redacted)).not.toContain("private launch plan");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("sk-live-secret");
    expect(JSON.stringify(redacted)).not.toContain("user@example.com");
    expect(redacted).toMatchObject({ redacted: true });
  });

  it("fails hard regressions and opt-in smoke failures while keeping trend warnings non-blocking", () => {
    const base = evaluateDiscussionQuality(sample());
    const deterministicResults = DISCUSSION_QUALITY_CORPUS.map((scenario) => ({
      ...base,
      scenarioId: scenario.id,
      mode: scenario.mode
    }));
    const result = evaluateQualityGate({
      deterministicRuns: [[
        ...deterministicResults.map((item) => ({
          ...item,
          scores: {
            ...item.scores,
            roleDifferentiation:
              ["solution-architecture", "review-release-readiness"].includes(item.scenarioId)
                ? 0.5
                : item.scores.roleDifferentiation
          }
        }))
      ]],
      evidenceLinks: ["ci://discussion-quality"],
      realProvider: {
        enabled: true,
        passed: false,
        evidenceLink: "ci://real-provider"
      }
    });

    expect(result.passed).toBe(false);
    expect(result.gateFailures).toEqual(
      expect.arrayContaining([
        "roleDifferentiation mean is below 0.8",
        "Opt-in real-Provider smoke evidence did not pass."
      ])
    );
    expect(result.evidenceLinks).toEqual([
      "ci://discussion-quality",
      "ci://real-provider"
    ]);
  });

  it("accepts a complete deterministic corpus when the optional smoke matrix is skipped", () => {
    const base = evaluateDiscussionQuality(sample());
    const results = DISCUSSION_QUALITY_CORPUS.map((scenario) => ({
      ...base,
      scenarioId: scenario.id,
      mode: scenario.mode
    }));
    const result = evaluateQualityGate({
      deterministicRuns: [results],
      evidenceLinks: ["ci://discussion-quality"]
    });

    expect(result.passed).toBe(true);
    expect(result.gateFailures).toEqual([]);
  });

  it("enforces the three-run release repeat policy", () => {
    const base = evaluateDiscussionQuality(sample());
    const run = DISCUSSION_QUALITY_CORPUS.map((scenario) => ({
      ...base,
      scenarioId: scenario.id,
      mode: scenario.mode
    }));
    const report = {
      deterministicRuns: Array.from(
        { length: DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT },
        () => structuredClone(run)
      ),
      evidenceLinks: ["ci://discussion-quality"]
    };
    expect(
      evaluateDiscussionQualityReport(report, {
        requireReleaseRepeatCount: true
      }).result.passed
    ).toBe(true);
    expect(() =>
      evaluateDiscussionQualityReport(
        { ...report, deterministicRuns: [run] },
        { requireReleaseRepeatCount: true }
      )
    ).toThrow(/must contain 3 runs/);
  });

  it("rejects results from an old rubric or a mismatched corpus scenario", () => {
    const result = evaluateDiscussionQuality(sample());
    expect(() =>
      validateQualityResults([
        { ...result, rubricVersion: "discussion-quality.v0" as never }
      ])
    ).toThrow("unsupported rubric");
    expect(() =>
      validateQualityResults([{ ...result, scenarioId: "unknown" }])
    ).toThrow("not compatible");
  });

  it("rejects results that were not evaluated against current runtime contracts", () => {
    const result = evaluateDiscussionQuality(sample());
    expect(() =>
      validateQualityResults([
        {
          ...result,
          contractVersions: {
            ...result.contractVersions,
            compressionSchemas: [99]
          }
        }
      ])
    ).toThrow("unsupported compression schema");
  });

  it("keeps legacy v2 Prompt records compatible after the v3 profile bump", () => {
    const result = evaluateDiscussionQuality(sample());
    expect(() =>
      validateQualityResults([
        {
          ...result,
          contractVersions: {
            ...result.contractVersions,
            promptProfile: "discussion-prompts.v2"
          }
        }
      ])
    ).not.toThrow();
  });

  it("keeps legacy v1 Prompt and Brief records compatible with the current rubric", () => {
    const input = sample();
    const legacyBrief = {
      ...input.brief!,
      schemaVersion: 1 as const,
      promptProfileVersion: "discussion-prompts.v1",
      minorityPositions: undefined,
      facts: input.brief!.facts.map((fact) => ({
        statement: fact.statement,
        evidence: "external:https://example.com/corpus"
      }))
    };
    delete (legacyBrief as { minorityPositions?: string[] }).minorityPositions;
    input.brief = parseDiscussionBrief(JSON.stringify(legacyBrief));
    input.discussion.promptProfileVersion = "discussion-prompts.v1";
    const result = evaluateDiscussionQuality(input);
    expect(() =>
      validateQualityResults([
        {
          ...result,
          contractVersions: {
            ...result.contractVersions,
            promptProfile: "discussion-prompts.v1",
            briefSchema: 1
          }
        }
      ])
    ).not.toThrow();
  });
});
