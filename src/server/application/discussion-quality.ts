import { createHash } from "node:crypto";
import type {
  AppState,
  Discussion,
  DiscussionMode
} from "@/server/domain/types";
import type { DiscussionBrief } from "@/server/application/discussion-brief";
import { DISCUSSION_BRIEF_SCHEMA_VERSION } from "@/server/application/discussion-brief";
import {
  DISCUSSION_COMPRESSION_SCHEMA_VERSION
} from "@/server/application/discussion-compression";
import {
  DISCUSSION_PROMPT_PROFILE_VERSION,
  LEGACY_DISCUSSION_PROMPT_PROFILES
} from "@/server/application/discussion-prompts";

export const DISCUSSION_EVIDENCE_PROTOCOL_VERSION = "discussion-evidence.v1";
const LEGACY_BRIEF_SCHEMA_VERSION = 1;

export const DISCUSSION_QUALITY_RUBRIC_VERSION =
  "discussion-quality.v1" as const;

export const QUALITY_DIMENSIONS = [
  "roleDifferentiation",
  "evidenceValidity",
  "unsupportedClaims",
  "challengeAndCorrection",
  "unresolvedDisagreement",
  "actionability",
  "briefFidelity"
] as const;

export type QualityDimension = (typeof QUALITY_DIMENSIONS)[number];

export type QualityCorpusScenario = {
  id: string;
  mode: DiscussionMode;
  promptProfileVersion: typeof DISCUSSION_PROMPT_PROFILE_VERSION;
  expected: {
    requiredRoles: string[];
    requiredSignal: "constraints" | "open_questions" | "options" | "risks";
    minimumFacts: number;
    minimumActions: number;
    requiresChallenge: boolean;
    requiresDisagreement: boolean;
  };
};

export const DISCUSSION_QUALITY_CORPUS: readonly QualityCorpusScenario[] = [
  {
    id: "requirements-release-scope",
    mode: "requirements",
    promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
    expected: {
      requiredRoles: ["analyst", "researcher", "skeptic", "designer", "facilitator"],
      requiredSignal: "constraints",
      minimumFacts: 1,
      minimumActions: 1,
      requiresChallenge: true,
      requiresDisagreement: true
    }
  },
  {
    id: "problem-root-cause",
    mode: "problem",
    promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
    expected: {
      requiredRoles: ["analyst", "researcher", "skeptic", "designer", "facilitator"],
      requiredSignal: "open_questions",
      minimumFacts: 1,
      minimumActions: 1,
      requiresChallenge: true,
      requiresDisagreement: true
    }
  },
  {
    id: "solution-architecture",
    mode: "solution",
    promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
    expected: {
      requiredRoles: ["analyst", "researcher", "skeptic", "designer", "facilitator"],
      requiredSignal: "options",
      minimumFacts: 1,
      minimumActions: 1,
      requiresChallenge: true,
      requiresDisagreement: true
    }
  },
  {
    id: "review-release-readiness",
    mode: "review",
    promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
    expected: {
      requiredRoles: ["analyst", "researcher", "skeptic", "designer", "facilitator"],
      requiredSignal: "risks",
      minimumFacts: 1,
      minimumActions: 1,
      requiresChallenge: true,
      requiresDisagreement: true
    }
  }
] as const;

export const DISCUSSION_QUALITY_HARD_THRESHOLD = 0.8;
export const DISCUSSION_QUALITY_TREND_VARIANCE = 0.005;
export const DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT = 3;

type ScoreMap = Record<QualityDimension, number>;

export type QualityFailureCode =
  | "invalid_evidence"
  | "unsupported_fact"
  | "missing_brief"
  | "invalid_brief"
  | "missing_facilitator"
  | "insufficient_roles"
  | "missing_quality_signal"
  | "brief_fidelity_regression";

export type QualityFailure = {
  code: QualityFailureCode;
  dimension: QualityDimension;
  message: string;
  scenarioId?: string;
};

export type DiscussionQualitySample = {
  scenarioId: string;
  state: AppState;
  discussion: Discussion;
  brief?: DiscussionBrief;
};

export type DiscussionQualityResult = {
  rubricVersion: typeof DISCUSSION_QUALITY_RUBRIC_VERSION;
  scenarioId: string;
  mode: DiscussionMode;
  contractVersions: {
    promptProfile: string;
    briefSchema: number | undefined;
    compressionSchemas: number[];
    evidenceProtocol: string;
  };
  scores: ScoreMap;
  hardFailures: QualityFailure[];
  evidence: {
    positionTurnCount: number;
    crossResponseTurnCount: number;
    factClaimCount: number;
    factClaimsWithValidEvidence: number;
    briefRevision: number | undefined;
  };
};

export type QualityDimensionAggregate = {
  mean: number;
  variance: number;
  min: number;
  max: number;
};

export type QualityRunsAggregate = {
  rubricVersion: typeof DISCUSSION_QUALITY_RUBRIC_VERSION;
  repeatCount: number;
  dimensions: Record<QualityDimension, QualityDimensionAggregate>;
  hardFailures: QualityFailure[];
  trendWarnings: Array<{
    dimension: QualityDimension;
    variance: number;
    message: string;
  }>;
};

export type DiscussionQualityGateInput = {
  deterministicRuns: DiscussionQualityResult[][];
  evidenceLinks?: string[];
  realProvider?: {
    enabled: boolean;
    passed: boolean;
    evidenceLink?: string;
  };
};

export type DiscussionQualityGateResult = QualityRunsAggregate & {
  passed: boolean;
  evidenceLinks: string[];
  gateFailures: string[];
};

export type DiscussionQualityReport = {
  deterministicRuns: DiscussionQualityResult[][];
  evidenceLinks?: string[];
  realProvider?: DiscussionQualityGateInput["realProvider"];
};

export type DiscussionQualityReportEvaluation = {
  result: DiscussionQualityGateResult;
  contractVersions: {
    promptProfiles: string[];
    briefSchemas: number[];
    compressionSchemas: number[];
    evidenceProtocols: string[];
  };
};

export function validateQualityResults(
  results: DiscussionQualityResult[]
): void {
  const corpus = new Map(
    DISCUSSION_QUALITY_CORPUS.map((scenario) => [scenario.id, scenario])
  );
  for (const result of results) {
    if (result.rubricVersion !== DISCUSSION_QUALITY_RUBRIC_VERSION) {
      throw new Error(
        `Quality result ${result.scenarioId} uses unsupported rubric ${result.rubricVersion}.`
      );
    }
    const scenario = corpus.get(result.scenarioId);
    if (!scenario || scenario.mode !== result.mode) {
      throw new Error(
        `Quality result ${result.scenarioId} is not compatible with the current corpus.`
      );
    }
    if (
      result.contractVersions.promptProfile !== DISCUSSION_PROMPT_PROFILE_VERSION &&
      !LEGACY_DISCUSSION_PROMPT_PROFILES.some(
        (profile) =>
          profile.promptProfileVersion ===
          result.contractVersions.promptProfile
      )
    ) {
      throw new Error(
        `Quality result ${result.scenarioId} uses an unsupported prompt profile.`
      );
    }
    if (
      result.contractVersions.briefSchema !== undefined &&
      result.contractVersions.briefSchema !== DISCUSSION_BRIEF_SCHEMA_VERSION &&
      result.contractVersions.briefSchema !== LEGACY_BRIEF_SCHEMA_VERSION
    ) {
      throw new Error(
        `Quality result ${result.scenarioId} uses an unsupported Brief schema.`
      );
    }
    if (result.contractVersions.evidenceProtocol !== DISCUSSION_EVIDENCE_PROTOCOL_VERSION) {
      throw new Error(
        `Quality result ${result.scenarioId} uses an unsupported evidence protocol.`
      );
    }
    if (
      result.contractVersions.compressionSchemas.some(
        (version) => version !== DISCUSSION_COMPRESSION_SCHEMA_VERSION
      )
    ) {
      throw new Error(
        `Quality result ${result.scenarioId} uses an unsupported compression schema.`
      );
    }
    for (const dimension of QUALITY_DIMENSIONS) {
      const score = result.scores[dimension];
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        throw new Error(
          `Quality result ${result.scenarioId} has an invalid ${dimension} score.`
        );
      }
    }
  }
}

function boundedScore(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function variance(values: number[], average: number): number {
  return mean(values.map((value) => (value - average) ** 2));
}

function hasValidEvidence(
  state: AppState,
  discussion: Discussion,
  alias: string
): boolean {
  const separator = alias.indexOf(":");
  if (separator <= 0) return false;
  const kind = alias.slice(0, separator);
  const sourceId = alias.slice(separator + 1);
  const referenceKind = kind === "external" ? "external_source" : kind;

  return state.evidenceReferences.some(
    (reference) =>
      reference.workspaceId === discussion.workspaceId &&
      reference.kind === referenceKind &&
      reference.sourceId === sourceId
  );
}

function completedTurns(discussion: Discussion, phase: "positions" | "cross_response") {
  return discussion.rounds
    .filter((round) => round.phase === phase)
    .flatMap((round) => round.turns)
    .filter((turn) => turn.status === "completed" && turn.payload);
}

function evaluateScores(
  sample: DiscussionQualitySample,
  failures: QualityFailure[]
): { scores: ScoreMap; evidence: DiscussionQualityResult["evidence"] } {
  const { state, discussion, brief } = sample;
  const positions = completedTurns(discussion, "positions");
  const crossResponses = completedTurns(discussion, "cross_response");
  const roles = new Set<string>(positions.map((turn) => turn.role));
  const distinctRoleOutputs = new Set(
    positions.map((turn) =>
      JSON.stringify({
        summary: turn.payload?.summary,
        claims: turn.payload?.claims.map((claim) => claim.statement),
        risks: turn.payload?.risks
      })
    )
  );
  const expectedRoles = new Set(
    DISCUSSION_QUALITY_CORPUS.find((item) => item.id === sample.scenarioId)
      ?.expected.requiredRoles ?? []
  );
  const scenario = DISCUSSION_QUALITY_CORPUS.find(
    (item) => item.id === sample.scenarioId
  );
  const roleCoverage = expectedRoles.size
    ? boundedScore(
        [...expectedRoles].filter((role) => roles.has(role)).length,
        expectedRoles.size
      )
    : boundedScore(roles.size, discussion.participants.length);
  const roleScore = Math.min(
    roleCoverage,
    boundedScore(distinctRoleOutputs.size, Math.max(1, positions.length))
  );
  if (!discussion.participants.some((item) => item.id === discussion.facilitatorParticipantId)) {
    failures.push({
      code: "missing_facilitator",
      dimension: "roleDifferentiation",
      message: "Discussion has no resolvable Facilitator Participant."
    });
  }
  if (roleScore < 1) {
    failures.push({
      code: "insufficient_roles",
      dimension: "roleDifferentiation",
      message: "The corpus roles are not all represented by completed Position Turns."
    });
  }

  const factClaims = positions.flatMap((turn) =>
    (turn.payload?.claims ?? []).filter((claim) => claim.kind === "fact")
  );
  const allClaims = positions.flatMap((turn) => turn.payload?.claims ?? []);
  const evidenceIds = factClaims.flatMap((claim) => claim.evidenceIds ?? []);
  const validEvidenceIdCount = evidenceIds.filter((id) =>
    hasValidEvidence(state, discussion, id)
  ).length;
  const validFactClaims = factClaims.filter((claim) => {
    const evidenceIds = claim.evidenceIds ?? [];
    return (
      evidenceIds.length > 0 &&
      evidenceIds.every((id) => hasValidEvidence(state, discussion, id))
    );
  });
  for (const claim of factClaims) {
    const evidenceIds = claim.evidenceIds ?? [];
    if (evidenceIds.length === 0) {
      failures.push({
        code: "unsupported_fact",
        dimension: "unsupportedClaims",
        message: "A fact claim has no evidence reference."
      });
      continue;
    }
    if (!evidenceIds.every((id) => hasValidEvidence(state, discussion, id))) {
      failures.push({
        code: "invalid_evidence",
        dimension: "evidenceValidity",
        message: "A fact claim references unavailable or out-of-scope evidence."
      });
      failures.push({
        code: "unsupported_fact",
        dimension: "unsupportedClaims",
        message: "A fact claim is not fully supported by valid evidence."
      });
    }
  }

  const challengeSignals = crossResponses.filter(
    (turn) =>
      (turn.payload?.agreements?.length ?? 0) > 0 &&
      (turn.payload?.disagreements?.length ?? 0) > 0 &&
      (turn.payload?.corrections?.length ?? 0) > 0
  ).length;
  const disagreementSignals = crossResponses.flatMap(
    (turn) => turn.payload?.disagreements ?? []
  );
  const briefDisagreements = brief?.disagreements ?? [];
  const briefMinority =
    brief?.schemaVersion === 2 ? brief.minorityPositions : [];
  const hasDisagreement = disagreementSignals.length > 0;
  const preservedDisagreement =
    !hasDisagreement ||
    (briefDisagreements.length > 0 &&
      briefDisagreements.some((item) =>
        disagreementSignals.some((signal) =>
          item.topic.toLowerCase().includes(signal.toLowerCase().slice(0, 20)) ||
          signal.toLowerCase().includes(item.topic.toLowerCase().slice(0, 20))
        )
      )) ||
    briefMinority.some((item) =>
      disagreementSignals.some((signal) =>
        item.toLowerCase().includes(signal.toLowerCase().slice(0, 20)) ||
        signal.toLowerCase().includes(item.toLowerCase().slice(0, 20))
      )
    );
  const actions = brief?.actions ?? [];
  const validActions = actions.filter(
    (action) => action.title.trim().length > 0 && action.description.trim().length > 0
  );
  const briefValid = Boolean(
    brief &&
      brief.discussionId === discussion.id &&
      brief.mode === discussion.mode &&
      brief.title.trim().length > 0 &&
      brief.options.length > 0 &&
      brief.options.some((option) => option.id === brief.recommendation.optionId) &&
      brief.recommendation.optionId.length > 0
  );
  const sourceStatements = new Set(
    positions.flatMap((turn) =>
      (turn.payload?.claims ?? []).map((claim) => claim.statement.toLowerCase())
    )
  );
  const briefStatements = new Set(
    (brief?.facts ?? []).map((fact) => fact.statement.toLowerCase())
  );
  const matchingBriefStatements = [...briefStatements].filter((statement) =>
    [...sourceStatements].some(
      (source) => source.includes(statement) || statement.includes(source)
    )
  );
  const briefSourceCoverage =
    sourceStatements.size + briefStatements.size === 0
      ? 0
      : (matchingBriefStatements.length * 2) /
        (sourceStatements.size + briefStatements.size);
  if (
    briefValid &&
    matchingBriefStatements.length !== briefStatements.size
  ) {
    failures.push({
      code: "brief_fidelity_regression",
      dimension: "briefFidelity",
      message: "The Discussion Brief contains facts that are not grounded in Position claims."
    });
  }
  if (!brief) {
    failures.push({
      code: "missing_brief",
      dimension: "briefFidelity",
      message: "The Discussion has no Discussion Brief for evaluation."
    });
  } else if (!briefValid) {
    failures.push({
      code: "invalid_brief",
      dimension: "briefFidelity",
      message: "The Discussion Brief does not match the Discussion contract."
    });
  }
  if (scenario?.expected.requiresChallenge && challengeSignals === 0) {
    failures.push({
      code: "missing_quality_signal",
      dimension: "challengeAndCorrection",
      message: "The corpus requires a Cross-response agreement, disagreement, and correction."
    });
  }
  if (scenario?.expected.requiresDisagreement && !hasDisagreement) {
    failures.push({
      code: "missing_quality_signal",
      dimension: "unresolvedDisagreement",
      message: "The corpus requires an explicit unresolved disagreement."
    });
  }
  const signalPresent = scenario
    ? scenario.expected.requiredSignal === "constraints"
      ? (discussion.constraints?.length ?? 0) > 0
      : scenario.expected.requiredSignal === "open_questions"
        ? positions.some((turn) => (turn.payload?.openQuestions.length ?? 0) > 0)
        : scenario.expected.requiredSignal === "options"
          ? (brief?.options.length ?? 0) > 0
          : positions.some((turn) => (turn.payload?.risks.length ?? 0) > 0)
    : true;
  if (!signalPresent) {
    failures.push({
      code: "missing_quality_signal",
      dimension: "briefFidelity",
      message: `The corpus requires a ${scenario?.expected.requiredSignal} signal.`
    });
  }
  if (scenario && factClaims.length < scenario.expected.minimumFacts) {
    failures.push({
      code: "missing_quality_signal",
      dimension: "evidenceValidity",
      message: `The corpus requires at least ${scenario.expected.minimumFacts} fact claim.`
    });
  }
  if (scenario && validActions.length < scenario.expected.minimumActions) {
    failures.push({
      code: "missing_quality_signal",
      dimension: "actionability",
      message: `The corpus requires at least ${scenario.expected.minimumActions} actionable Brief item.`
    });
  }

  const scores: ScoreMap = {
    roleDifferentiation: roleScore,
    evidenceValidity: boundedScore(validEvidenceIdCount, evidenceIds.length),
    unsupportedClaims: boundedScore(
      allClaims.length - (factClaims.length - validFactClaims.length),
      allClaims.length
    ),
    challengeAndCorrection: boundedScore(
      challengeSignals,
      crossResponses.length
    ),
    unresolvedDisagreement:
      preservedDisagreement &&
      (!scenario?.expected.requiresDisagreement || hasDisagreement)
        ? 1
        : 0,
    actionability: boundedScore(
      validActions.length,
      Math.max(actions.length, scenario?.expected.minimumActions ?? 1)
    ),
    briefFidelity: briefValid ? briefSourceCoverage : 0
  };

  return {
    scores,
    evidence: {
      positionTurnCount: positions.length,
      crossResponseTurnCount: crossResponses.length,
      factClaimCount: factClaims.length,
      factClaimsWithValidEvidence: validFactClaims.length,
      briefRevision: undefined
    }
  };
}

export function evaluateDiscussionQuality(
  sample: DiscussionQualitySample
): DiscussionQualityResult {
  const failures: QualityFailure[] = [];
  const evaluated = evaluateScores(sample, failures);
  for (const failure of failures) failure.scenarioId = sample.scenarioId;
  return {
    rubricVersion: DISCUSSION_QUALITY_RUBRIC_VERSION,
    scenarioId: sample.scenarioId,
    mode: sample.discussion.mode,
    scores: evaluated.scores,
    hardFailures: failures,
    evidence: evaluated.evidence,
    contractVersions: {
      promptProfile: sample.discussion.promptProfileVersion ?? "unknown",
      briefSchema: sample.brief?.schemaVersion,
      compressionSchemas: [
        ...new Set(
          sample.state.discussionCompressions
            .filter((item) => item.discussionId === sample.discussion.id)
            .map((item) => item.schemaVersion)
        )
      ],
      evidenceProtocol: DISCUSSION_EVIDENCE_PROTOCOL_VERSION
    }
  };
}

export function evaluateQualityRuns(
  runs: DiscussionQualityResult[][]
): QualityRunsAggregate {
  const results = runs.flat();
  validateQualityResults(results);
  const dimensions = Object.fromEntries(
    QUALITY_DIMENSIONS.map((dimension) => {
      const values = results.map((result) => result.scores[dimension]);
      const average = mean(values);
      return [dimension, {
        mean: average,
        variance: variance(values, average),
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0
      }];
    })
  ) as Record<QualityDimension, QualityDimensionAggregate>;
  const trendWarnings = QUALITY_DIMENSIONS.flatMap((dimension) => {
    const aggregate = dimensions[dimension];
    return aggregate.variance > DISCUSSION_QUALITY_TREND_VARIANCE
      ? [{
          dimension,
          variance: aggregate.variance,
          message: `${dimension} varies across repeated runs; review the trend without treating prose as a snapshot.`
        }]
      : [];
  });
  return {
    rubricVersion: DISCUSSION_QUALITY_RUBRIC_VERSION,
    repeatCount: runs.length,
    dimensions,
    hardFailures: results.flatMap((result) => result.hardFailures),
    trendWarnings
  };
}

export function evaluateQualityGate(
  input: DiscussionQualityGateInput
): DiscussionQualityGateResult {
  const aggregate = evaluateQualityRuns(input.deterministicRuns);
  const gateFailures = aggregate.hardFailures.map(
    (failure) => `${failure.scenarioId ?? "scenario"}: ${failure.message}`
  );
  for (const dimension of QUALITY_DIMENSIONS) {
    if (aggregate.dimensions[dimension].mean < DISCUSSION_QUALITY_HARD_THRESHOLD) {
      gateFailures.push(
        `${dimension} mean is below ${DISCUSSION_QUALITY_HARD_THRESHOLD}`
      );
    }
  }
  if (input.realProvider?.enabled && !input.realProvider.passed) {
    gateFailures.push("Opt-in real-Provider smoke evidence did not pass.");
  }
  const deterministicEvidenceLinks = input.evidenceLinks ?? [];
  const evidenceLinks = [
    ...deterministicEvidenceLinks,
    ...(input.realProvider?.evidenceLink ? [input.realProvider.evidenceLink] : [])
  ];
  if (deterministicEvidenceLinks.length === 0) {
    gateFailures.push("Release evidence must link deterministic CI results.");
  }
  const validLinks = evidenceLinks.every((link) =>
    /^(?:https?:\/\/|ci:\/\/|artifact:\/\/)/.test(link)
  );
  if (!validLinks) gateFailures.push("Release evidence contains an invalid link.");
  const corpusIds = new Set(DISCUSSION_QUALITY_CORPUS.map((scenario) => scenario.id));
  for (const [index, run] of input.deterministicRuns.entries()) {
    const runIds = new Set(run.map((result) => result.scenarioId));
    for (const scenarioId of corpusIds) {
      if (!runIds.has(scenarioId)) {
        gateFailures.push(`Deterministic run ${index + 1} is missing ${scenarioId}.`);
      }
    }
  }
  if (input.realProvider?.enabled && !input.realProvider.evidenceLink) {
    gateFailures.push("Enabled real-Provider smoke requires an evidence link.");
  }
  return {
    ...aggregate,
    passed: gateFailures.length === 0,
    evidenceLinks,
    gateFailures
  };
}

export function evaluateDiscussionQualityReport(
  report: DiscussionQualityReport,
  options: { requireReleaseRepeatCount?: boolean } = {}
): DiscussionQualityReportEvaluation {
  if (
    !Array.isArray(report.deterministicRuns) ||
    report.deterministicRuns.length === 0
  ) {
    throw new Error("Quality report must contain at least one deterministic run.");
  }
  const deterministicResults = report.deterministicRuns.flat();
  validateQualityResults(deterministicResults);
  const scenarioIds = new Set(
    deterministicResults.map((result) => result.scenarioId)
  );
  for (const scenario of DISCUSSION_QUALITY_CORPUS) {
    if (!scenarioIds.has(scenario.id)) {
      throw new Error(`Quality report is missing corpus scenario ${scenario.id}.`);
    }
  }
  if (options.requireReleaseRepeatCount) {
    if (
      report.deterministicRuns.length !==
      DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT
    ) {
      throw new Error(
        `Release quality evidence must contain ${DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT} runs.`
      );
    }
    for (const [index, run] of report.deterministicRuns.entries()) {
      const runScenarioIds = new Set(
        run.map((result) => result.scenarioId)
      );
      if (runScenarioIds.size !== DISCUSSION_QUALITY_CORPUS.length) {
        throw new Error(
          `Release quality run ${index + 1} must cover every corpus mode.`
        );
      }
    }
    for (const scenario of DISCUSSION_QUALITY_CORPUS) {
      const occurrences = deterministicResults.filter(
        (result) => result.scenarioId === scenario.id
      ).length;
      if (occurrences !== DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT) {
        throw new Error(
          `Release quality evidence must run ${scenario.id} exactly ${DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT} times.`
        );
      }
    }
  }
  return {
    result: evaluateQualityGate(report),
    contractVersions: {
      promptProfiles: [
        ...new Set(
          deterministicResults.map(
            (result) => result.contractVersions.promptProfile
          )
        )
      ],
      briefSchemas: [
        ...new Set(
          deterministicResults
            .map((result) => result.contractVersions.briefSchema)
            .filter((value): value is number => value !== undefined)
        )
      ],
      compressionSchemas: [
        ...new Set(
          deterministicResults.flatMap(
            (result) => result.contractVersions.compressionSchemas
          )
        )
      ],
      evidenceProtocols: [
        ...new Set(
          deterministicResults.map(
            (result) => result.contractVersions.evidenceProtocol
          )
        )
      ]
    }
  };
}

const SENSITIVE_KEY = /(prompt|response|credential|secret|token|evidence|content)/i;
const SENSITIVE_VALUE = /(bearer\s+\S+|sk-[a-z0-9_-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,})/gi;

export function redactQualityEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactQualityEvidence);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return value.replaceAll(SENSITIVE_VALUE, "[REDACTED]");
  }
  const output: Record<string, unknown> = { redacted: true };
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : redactQualityEvidence(item);
  }
  return output;
}

export function qualityEvidenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(redactQualityEvidence(value)))
    .digest("hex");
}
