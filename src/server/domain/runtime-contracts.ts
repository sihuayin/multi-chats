import { z } from "zod";
import { PROVIDER_IDS } from "@/lib/provider-catalog";

const identifier = z.string().trim().min(1);
const timestamp = z.string().trim().min(1);
const tokenCount = z.number().int().nonnegative();

export const modelTargetConfigSchema = z
  .object({
    providerCredentialId: identifier,
    modelId: identifier
  })
  .strict();

export const modelUsageSchema = z
  .object({
    inputTokens: tokenCount.optional(),
    outputTokens: tokenCount.optional(),
    cachedInputTokens: tokenCount.optional(),
    reasoningTokens: tokenCount.optional(),
    totalTokens: tokenCount.optional(),
    source: z.enum(["provider", "estimated", "unknown"])
  })
  .strict();

export const providerAttemptSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    runId: identifier.optional(),
    discussionId: identifier.optional(),
    roundId: identifier.optional(),
    turnId: identifier.optional(),
    purpose: z.enum([
      "conversation",
      "discussion_turn",
      "discussion_synthesis",
      "discussion_compression",
      "smoke_test"
    ]),
    provider: z.enum(PROVIDER_IDS),
    modelId: identifier,
    targetOrder: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    status: z.enum([
      "started",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
      "ambiguous"
    ]),
    requestId: identifier.optional(),
    providerRequestId: identifier.optional(),
    fallbackFromAttemptId: identifier.optional(),
    errorKind: identifier.optional(),
    usage: modelUsageSchema,
    pricingId: identifier.optional(),
    estimatedCostMicros: z.number().int().nullable().optional(),
    startedAt: timestamp,
    completedAt: timestamp.optional()
  })
  .strict();

export const evidenceReferenceSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    kind: z.enum([
      "message",
      "turn",
      "task",
      "artifact",
      "tool_result",
      "external_source"
    ]),
    sourceId: identifier,
    locator: z.string().optional(),
    excerptHash: z.string().optional(),
    retrievedAt: timestamp.optional(),
    createdAt: timestamp
  })
  .strict();

export const discussionInterventionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    discussionId: identifier,
    kind: z.enum([
      "constraint",
      "question",
      "material",
      "correction",
      "focus",
      "participant_change",
      "mode_change",
      "budget_change",
      "extension",
      "stop",
      "cancel"
    ]),
    content: z.string(),
    status: z.enum(["pending", "applied", "rejected", "superseded"]),
    createdBy: identifier,
    idempotencyKey: identifier.optional(),
    appliedPhase: z
      .enum(["positions", "cross_response", "synthesis"])
      .optional(),
    appliedRoundId: identifier.optional(),
    resultingDiscussionRevision: z.number().int().nonnegative().optional(),
    appliedAt: timestamp.optional(),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict();

export const discussionCompressionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    discussionId: identifier,
    status: z.enum(["pending", "completed", "failed"]),
    sourceRoundIds: z.array(identifier),
    sourceTurnIds: z.array(identifier),
    evidenceIds: z.array(identifier),
    content: z.string(),
    unresolvedQuestions: z.array(z.string()),
    minorityPositions: z.array(z.string()),
    schemaVersion: z.number().int().positive(),
    promptProfileVersion: identifier,
    contentHash: identifier,
    provider: z.enum(PROVIDER_IDS).optional(),
    modelId: identifier.optional(),
    createdByAttemptId: identifier.optional(),
    previousCompressionId: identifier.optional(),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict();

export const discussionContextRevisionSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    discussionId: identifier,
    roundId: identifier,
    turnId: identifier,
    inputTokens: tokenCount,
    outputReserveTokens: tokenCount,
    countSource: z.enum(["exact", "estimated", "unknown"]),
    contextHash: identifier,
    messageIds: z.array(identifier),
    compressionIds: z.array(identifier),
    createdAt: timestamp
  })
  .strict();

export const modelPricingSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    provider: z.enum(PROVIDER_IDS),
    modelId: identifier,
    currency: identifier,
    inputMicrosPerMillionTokens: tokenCount,
    outputMicrosPerMillionTokens: tokenCount,
    cachedInputMicrosPerMillionTokens: tokenCount.optional(),
    effectiveAt: timestamp,
    source: identifier,
    version: identifier,
    createdAt: timestamp
  })
  .strict();

const runtimeLedgers = [
  ["providerAttempts", providerAttemptSchema],
  ["evidenceReferences", evidenceReferenceSchema],
  ["discussionCompressions", discussionCompressionSchema],
  ["discussionInterventions", discussionInterventionSchema],
  ["discussionContextRevisions", discussionContextRevisionSchema],
  ["modelPricing", modelPricingSchema]
] as const;

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

function ids(value: unknown): Set<string> {
  return new Set(
    records(value)
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string")
  );
}

function requireReference(
  value: string | undefined,
  values: Set<string>,
  ledger: string
): void {
  if (value !== undefined && !values.has(value)) {
    throw new Error(`Workspace ${ledger} are invalid`);
  }
}

function discussionIndex(state: Record<string, unknown>): {
  discussionIds: Set<string>;
  roundDiscussionIds: Map<string, string>;
  turnDiscussionIds: Map<string, string>;
} {
  const discussionIds = new Set<string>();
  const roundDiscussionIds = new Map<string, string>();
  const turnDiscussionIds = new Map<string, string>();
  for (const discussion of records(state.discussions)) {
    if (typeof discussion.id !== "string") continue;
    discussionIds.add(discussion.id);
    for (const round of records(discussion.rounds)) {
      if (typeof round.id === "string") {
        roundDiscussionIds.set(round.id, discussion.id);
      }
      for (const turn of records(round.turns)) {
        if (typeof turn.id === "string") {
          turnDiscussionIds.set(turn.id, discussion.id);
        }
      }
    }
  }
  return { discussionIds, roundDiscussionIds, turnDiscussionIds };
}

export function validateRuntimeContracts(
  state: Record<string, unknown>,
  workspaceId: string
): void {
  const parsedValues = new Map<string, unknown[]>();
  for (const [key, schema] of runtimeLedgers) {
    const parsed = z.array(schema).safeParse(state[key]);
    if (!parsed.success) {
      throw new Error(`Workspace ${key} are invalid`);
    }
    parsedValues.set(key, parsed.data);
    for (const item of parsed.data) {
      if (item.workspaceId !== workspaceId) {
        throw new Error(`Workspace ${key} are invalid`);
      }
    }
  }

  const providerIds = ids(state.providers);
  for (const employee of records(state.employees)) {
    if (employee.fallbackTargets === undefined) continue;
    if (!Array.isArray(employee.fallbackTargets)) {
      throw new Error("Workspace Employee fallback targets are invalid");
    }
    for (const target of employee.fallbackTargets) {
      const parsed = modelTargetConfigSchema.safeParse(target);
      if (
        !parsed.success ||
        !providerIds.has(parsed.data.providerCredentialId)
      ) {
        throw new Error("Workspace Employee fallback targets are invalid");
      }
    }
  }

  const {
    discussionIds,
    roundDiscussionIds,
    turnDiscussionIds
  } = discussionIndex(state);
  const messageIds = ids(state.messages);
  const taskIds = ids(state.tasks);
  const artifactIds = ids(state.artifacts);
  const runIds = ids(state.runs);
  const attemptIds = ids(parsedValues.get("providerAttempts"));
  const evidenceIds = ids(parsedValues.get("evidenceReferences"));
  const compressionIds = ids(parsedValues.get("discussionCompressions"));
  const pricingIds = ids(parsedValues.get("modelPricing"));

  for (const attempt of parsedValues.get("providerAttempts") ?? []) {
    const record = attempt as Record<string, unknown>;
    requireReference(record.runId as string | undefined, runIds, "providerAttempts");
    requireReference(
      record.discussionId as string | undefined,
      discussionIds,
      "providerAttempts"
    );
    requireReference(
      record.roundId as string | undefined,
      new Set(roundDiscussionIds.keys()),
      "providerAttempts"
    );
    requireReference(
      record.turnId as string | undefined,
      new Set(turnDiscussionIds.keys()),
      "providerAttempts"
    );
    requireReference(
      record.pricingId as string | undefined,
      pricingIds,
      "providerAttempts"
    );
    requireReference(
      record.fallbackFromAttemptId as string | undefined,
      attemptIds,
      "providerAttempts"
    );
  }

  for (const evidence of parsedValues.get("evidenceReferences") ?? []) {
    const record = evidence as Record<string, unknown>;
    const kind = record.kind as string;
    const sources =
      kind === "message"
        ? messageIds
        : kind === "turn"
          ? new Set(turnDiscussionIds.keys())
          : kind === "task"
            ? taskIds
            : kind === "artifact"
              ? artifactIds
              : undefined;
    if (sources) {
      requireReference(record.sourceId as string, sources, "evidenceReferences");
    }
  }

  for (const compression of parsedValues.get("discussionCompressions") ?? []) {
    const record = compression as Record<string, unknown>;
    const discussionId = record.discussionId as string;
    requireReference(discussionId, discussionIds, "discussionCompressions");
    for (const roundId of record.sourceRoundIds as string[]) {
      if (roundDiscussionIds.get(roundId) !== discussionId) {
        throw new Error("Workspace discussionCompressions are invalid");
      }
    }
    for (const turnId of record.sourceTurnIds as string[]) {
      if (turnDiscussionIds.get(turnId) !== discussionId) {
        throw new Error("Workspace discussionCompressions are invalid");
      }
    }
    for (const evidenceId of record.evidenceIds as string[]) {
      requireReference(
        evidenceId,
        evidenceIds,
        "discussionCompressions"
      );
    }
    requireReference(
      record.createdByAttemptId as string | undefined,
      attemptIds,
      "discussionCompressions"
    );
    requireReference(
      record.previousCompressionId as string | undefined,
      compressionIds,
      "discussionCompressions"
    );
  }

  for (const intervention of parsedValues.get("discussionInterventions") ?? []) {
    const record = intervention as Record<string, unknown>;
    const discussionId = record.discussionId as string;
    requireReference(discussionId, discussionIds, "discussionInterventions");
    const roundId = record.appliedRoundId as string | undefined;
    if (roundId && roundDiscussionIds.get(roundId) !== discussionId) {
      throw new Error("Workspace discussionInterventions are invalid");
    }
  }

  for (
    const revision of parsedValues.get("discussionContextRevisions") ?? []
  ) {
    const record = revision as Record<string, unknown>;
    const discussionId = record.discussionId as string;
    requireReference(discussionId, discussionIds, "discussionContextRevisions");
    const roundId = record.roundId as string;
    if (roundDiscussionIds.get(roundId) !== discussionId) {
      throw new Error("Workspace discussionContextRevisions are invalid");
    }
    const turnId = record.turnId as string;
    if (turnDiscussionIds.get(turnId) !== discussionId) {
      throw new Error("Workspace discussionContextRevisions are invalid");
    }
    for (const messageId of record.messageIds as string[]) {
      requireReference(
        messageId,
        messageIds,
        "discussionContextRevisions"
      );
    }
    for (const compressionId of record.compressionIds as string[]) {
      requireReference(
        compressionId,
        compressionIds,
        "discussionContextRevisions"
      );
    }
  }
}
