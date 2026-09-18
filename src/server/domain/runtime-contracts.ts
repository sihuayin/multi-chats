import { z } from "zod";
import { PROVIDER_IDS } from "@/lib/provider-catalog";
import { PROVIDER_FAILURE_KINDS } from "@/server/domain/types";

const identifier = z.string().trim().min(1);
const timestamp = z.string().trim().min(1);
const tokenCount = z.number().int().nonnegative();
const legacyProviderErrorKind = z.enum([
  "evidence_invalid",
  "model_error"
]);

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
    cacheWriteTokens: tokenCount.optional(),
    cacheWrite1hTokens: tokenCount.optional(),
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
      "discussion_rerank",
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
    responseModel: identifier.optional(),
    fallbackFromAttemptId: identifier.optional(),
    errorKind: z
      .union([z.enum(PROVIDER_FAILURE_KINDS), legacyProviderErrorKind])
      .optional(),
    errorCode: identifier.optional(),
    httpStatus: z.number().int().positive().optional(),
    retryAfterMs: tokenCount.optional(),
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
    compressionProfileVersion: identifier,
    contentHash: identifier,
    sourceSpanHash: identifier,
    strategy: z.enum(["semantic", "extractive"]),
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
    contextWindow: z.number().int().positive(),
    maxOutputTokens: tokenCount,
    safetyMarginTokens: tokenCount,
    schemaOverheadTokens: tokenCount,
    toolOverheadTokens: tokenCount,
    inputTokens: tokenCount,
    outputReserveTokens: tokenCount,
    countSource: z.enum(["exact", "estimated", "unknown"]),
    contextHash: identifier,
    roundIds: z.array(identifier),
    turnIds: z.array(identifier),
    messageIds: z.array(identifier),
    compressionIds: z.array(identifier),
    createdAt: timestamp
  })
  .strict();

export const sourceSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    title: identifier,
    kind: z.enum(["url", "file"]),
    location: identifier,
    status: z.enum(["pending", "ingesting", "ready", "failed"]),
    error: z.string().optional(),
    contentHash: identifier.optional(),
    chunkCount: z.number().int().nonnegative(),
    pendingContent: z.string().optional(),
    deletedAt: timestamp.optional(),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict();

export const chunkSchema = z
  .object({
    id: identifier,
    workspaceId: identifier,
    sourceId: identifier,
    index: z.number().int().nonnegative(),
    content: z.string(),
    contentHash: identifier,
    superseded: z.boolean().optional(),
    createdAt: timestamp,
    updatedAt: timestamp
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
  ["modelPricing", modelPricingSchema],
  ["sources", sourceSchema],
  ["chunks", chunkSchema]
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

function optionalIdentifier(
  value: unknown,
  message: string
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function runCorrelatesWithTask(
  run: { conversationId?: string; taskId?: string } | undefined,
  task: { id: string; conversationId?: string }
): boolean {
  return Boolean(
    run &&
      run.conversationId === task.conversationId &&
      (run.taskId === undefined || run.taskId === task.id)
  );
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
    if (employee.fallbackTargets.length > 4) {
      throw new Error("Workspace Employee fallback targets are invalid");
    }
    const targetKeys = new Set<string>();
    const primaryProviderId = employee.providerCredentialId;
    const primaryModelId = employee.modelId;
    if (
      typeof primaryProviderId === "string" &&
      typeof primaryModelId === "string"
    ) {
      targetKeys.add(`${primaryProviderId}\0${primaryModelId}`);
    }
    for (const target of employee.fallbackTargets) {
      const parsed = modelTargetConfigSchema.safeParse(target);
      if (
        !parsed.success ||
        !providerIds.has(parsed.data.providerCredentialId)
      ) {
        throw new Error("Workspace Employee fallback targets are invalid");
      }
      const key = `${parsed.data.providerCredentialId}\0${parsed.data.modelId}`;
      if (targetKeys.has(key)) {
        throw new Error("Workspace Employee fallback targets are invalid");
      }
      targetKeys.add(key);
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
  const tasksById = new Map(
    records(state.tasks).map((task) => [
      String(task.id),
      task as { id: string; conversationId?: string }
    ])
  );
  const messagesById = new Map(
    records(state.messages).map((message) => [
      String(message.id),
      message as {
        id: string;
        conversationId?: string;
        runId?: string;
        taskId?: string;
      }
    ])
  );
  const runsById = new Map(
    records(state.runs).map((run) => [
      String(run.id),
      run as {
        id: string;
        conversationId?: string;
        discussionId?: string;
        taskId?: string;
      }
    ])
  );
  const attemptIds = ids(parsedValues.get("providerAttempts"));
  const attemptsById = new Map(
    (parsedValues.get("providerAttempts") ?? []).map((attempt) => [
      (attempt as { id: string }).id,
      attempt as { runId?: string; targetOrder?: number }
    ])
  );
  const evidenceIds = ids(parsedValues.get("evidenceReferences"));
  const compressionIds = ids(parsedValues.get("discussionCompressions"));
  const pricingIds = ids(parsedValues.get("modelPricing"));
  const sourceIds = ids(parsedValues.get("sources"));

  for (const message of records(state.messages)) {
    const taskId = optionalIdentifier(
      message.taskId,
      "Workspace Message Task correlation is invalid"
    );
    if (!taskId) continue;
    const task = tasksById.get(taskId);
    if (
      !task ||
      task.conversationId !== message.conversationId
    ) {
      throw new Error("Workspace Message Task correlation is invalid");
    }
    const runId = optionalIdentifier(
      message.runId,
      "Workspace Message Task correlation is invalid"
    );
    if (runId === undefined) continue;
    const run = runsById.get(runId);
    if (
      !run ||
      run.conversationId !== message.conversationId ||
      run.taskId !== taskId
    ) {
      throw new Error("Workspace Message Run correlation is invalid");
    }
  }

  for (const run of records(state.runs)) {
    const taskId = optionalIdentifier(
      run.taskId,
      "Workspace Run Task correlation is invalid"
    );
    if (!taskId) continue;
    const task = tasksById.get(taskId);
    if (
      !task ||
      task.conversationId !== run.conversationId ||
      run.discussionId !== undefined
    ) {
      throw new Error("Workspace Run Task correlation is invalid");
    }
    const triggerMessageId = optionalIdentifier(
      run.triggerMessageId,
      "Workspace Run Task correlation is invalid"
    );
    const triggerMessage = triggerMessageId
      ? messagesById.get(triggerMessageId)
      : undefined;
    if (
      !triggerMessage ||
      triggerMessage.conversationId !== run.conversationId ||
      triggerMessage.taskId !== taskId ||
      triggerMessage.runId !== run.id
    ) {
      throw new Error("Workspace Run Task correlation is invalid");
    }
  }

  for (const task of records(state.tasks)) {
    if (!Array.isArray(task.history)) continue;
    for (const value of task.history) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Workspace Task Run correlation is invalid");
      }
      const entry = value as Record<string, unknown>;
      const runId = optionalIdentifier(
        entry.runId,
        "Workspace Task Run correlation is invalid"
      );
      if (!runId) continue;
      const run = runsById.get(runId);
      if (
        !run ||
        !runCorrelatesWithTask(run, {
          id: String(task.id),
          conversationId:
            typeof task.conversationId === "string"
              ? task.conversationId
              : undefined
        })
      ) {
        throw new Error("Workspace Task Run correlation is invalid");
      }
    }
  }

  for (const artifact of records(state.artifacts)) {
    const runId = optionalIdentifier(
      artifact.runId,
      "Workspace Artifact Run correlation is invalid"
    );
    if (!runId) continue;
    const run = runsById.get(runId);
    const task =
      artifact.ownerType === "task"
        ? tasksById.get(String(artifact.ownerId))
        : undefined;
    const validOwnerRun =
      run &&
      ((artifact.ownerType === "task" &&
        task &&
        runCorrelatesWithTask(run, {
          id: String(artifact.ownerId),
          conversationId: task.conversationId
        })) ||
        (artifact.ownerType === "discussion" &&
          run.discussionId === artifact.ownerId));
    if (!validOwnerRun) {
      throw new Error("Workspace Artifact Run correlation is invalid");
    }
  }

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
    const fallbackFromAttempt = record.fallbackFromAttemptId
      ? attemptsById.get(String(record.fallbackFromAttemptId))
      : undefined;
    if (
      fallbackFromAttempt &&
      (fallbackFromAttempt.runId !== record.runId ||
        fallbackFromAttempt.targetOrder === undefined ||
        typeof record.targetOrder !== "number" ||
        fallbackFromAttempt.targetOrder >= record.targetOrder)
    ) {
      throw new Error("Workspace providerAttempts are invalid");
    }
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

  for (const chunk of parsedValues.get("chunks") ?? []) {
    const record = chunk as Record<string, unknown>;
    requireReference(
      record.sourceId as string,
      sourceIds,
      "chunks"
    );
  }

  for (const discussion of records(state.discussions)) {
    const sourceIdsField = discussion.sourceIds;
    if (sourceIdsField === undefined) continue;
    if (
      !Array.isArray(sourceIdsField) ||
      sourceIdsField.some((id) => typeof id !== "string")
    ) {
      throw new Error("Workspace Discussion sourceIds are invalid");
    }
    for (const sourceId of sourceIdsField as string[]) {
      requireReference(sourceId, sourceIds, "Discussion sourceIds");
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
    for (const roundId of record.roundIds as string[]) {
      if (roundDiscussionIds.get(roundId) !== discussionId) {
        throw new Error(
          "Workspace discussionContextRevisions are invalid"
        );
      }
    }
    for (const turnId of record.turnIds as string[]) {
      if (turnDiscussionIds.get(turnId) !== discussionId) {
        throw new Error(
          "Workspace discussionContextRevisions are invalid"
        );
      }
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
