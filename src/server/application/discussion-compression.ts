import { createHash } from "node:crypto";
import {
  DISCUSSION_PROMPT_PROFILE_VERSION
} from "@/server/application/discussion-prompts";
import type {
  DiscussionCompression,
  DiscussionRound,
  ProviderId
} from "@/server/domain/types";

export const DISCUSSION_COMPRESSION_SCHEMA_VERSION = 1;
export const DISCUSSION_COMPRESSION_PROFILE_VERSION =
  "discussion-compression.v1";

export type CompressionSource = {
  sourceRoundIds: string[];
  sourceTurnIds: string[];
  evidenceIds: string[];
  unresolvedQuestions: string[];
  minorityPositions: string[];
  sourceSpanHash: string;
};

export function compressionSource(
  rounds: DiscussionRound[]
): CompressionSource {
  const sourceRoundIds: string[] = [];
  const sourceTurnIds: string[] = [];
  const evidenceIds = new Set<string>();
  const unresolvedQuestions = new Set<string>();
  const minorityPositions = new Set<string>();
  const hash = createHash("sha256");

  for (const round of rounds) {
    sourceRoundIds.push(round.id);
    hash.update(`round:${round.id}\n`);
    for (const turn of round.turns) {
      if (turn.status !== "completed") continue;
      sourceTurnIds.push(turn.id);
      hash.update(
        `turn:${turn.id}:${turn.attempt ?? 1}:${
          turn.payload ? JSON.stringify(turn.payload) : turn.content ?? ""
        }\n`
      );
      for (const claim of turn.payload?.claims ?? []) {
        for (const evidenceId of claim.evidenceIds ?? []) {
          evidenceIds.add(evidenceId);
        }
      }
      for (const question of turn.payload?.openQuestions ?? []) {
        unresolvedQuestions.add(question);
      }
      for (const disagreement of turn.payload?.disagreements ?? []) {
        minorityPositions.add(disagreement);
      }
    }
  }

  return {
    sourceRoundIds,
    sourceTurnIds,
    evidenceIds: [...evidenceIds],
    unresolvedQuestions: [...unresolvedQuestions],
    minorityPositions: [...minorityPositions],
    sourceSpanHash: hash.digest("hex")
  };
}

export function compressionMatches(
  compression: DiscussionCompression,
  source: CompressionSource,
  target: {
    provider?: ProviderId;
    modelId?: string;
  } = {}
): boolean {
  return (
    compression.status === "completed" &&
    compression.schemaVersion ===
      DISCUSSION_COMPRESSION_SCHEMA_VERSION &&
    compression.promptProfileVersion ===
      DISCUSSION_PROMPT_PROFILE_VERSION &&
    compression.compressionProfileVersion ===
      DISCUSSION_COMPRESSION_PROFILE_VERSION &&
    compression.sourceSpanHash === source.sourceSpanHash &&
    compression.provider === target.provider &&
    compression.modelId === target.modelId
  );
}

export function buildExtractiveDigest(
  rounds: DiscussionRound[]
): string {
  const clip = (value: string, maximum: number) =>
    value.length <= maximum
      ? value
      : `${value.slice(0, maximum - 3).trimEnd()}...`;
  return rounds
    .map((round) => {
      const turns = round.turns
        .filter((turn) => turn.status === "completed")
        .map((turn) => {
          if (!turn.payload) {
            return `- ${turn.role}: ${clip(turn.content ?? "", 800)}`;
          }
          const claims = turn.payload.claims.map(
            (claim) =>
              `  - [${claim.kind ?? "inference"}] ${
                clip(claim.statement, 400)
              } (confidence: ${claim.confidence}${
                claim.evidenceIds?.length
                  ? `; evidence: ${claim.evidenceIds.join(", ")}`
                  : ""
              })`
          );
          const questions = turn.payload.openQuestions.map(
            (question) => `  - unresolved: ${question}`
          );
          const minority = (turn.payload.disagreements ?? []).map(
            (position) => `  - minority: ${position}`
          );
          return [
            `- ${turn.role}: ${clip(turn.payload.summary, 600)}`,
            ...claims,
            ...questions,
            ...minority
          ].join("\n");
        });
      return `Round ${round.roundNumber} (${round.phase})\n${turns.join("\n")}`;
    })
    .join("\n\n");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
