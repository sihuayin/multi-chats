import type { ModelUsage, ProviderAttempt } from "@/server/domain/types";

export type AggregatedModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated" | "unknown" | "mixed";
  attemptCount: number;
  succeededAttemptCount: number;
  failedAttemptCount: number;
  cancelledAttemptCount: number;
  unknownUsageAttemptCount: number;
};

function addOptional(
  left: number | undefined,
  right: number | undefined
): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function hasUsageValues(usage: ModelUsage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens,
    usage.cacheWrite1hTokens,
    usage.reasoningTokens,
    usage.totalTokens
  ].some((value) => value !== undefined);
}

export function mergeModelUsage(
  current: ModelUsage,
  incoming: ModelUsage
): ModelUsage {
  if (incoming.source === "unknown") return current;
  if (current.source === "unknown") return incoming;
  const source =
    current.source === "provider" && incoming.source === "provider"
      ? "provider"
      : "estimated";
  return {
    inputTokens: addOptional(current.inputTokens, incoming.inputTokens),
    outputTokens: addOptional(current.outputTokens, incoming.outputTokens),
    cachedInputTokens: addOptional(
      current.cachedInputTokens,
      incoming.cachedInputTokens
    ),
    cacheWriteTokens: addOptional(
      current.cacheWriteTokens,
      incoming.cacheWriteTokens
    ),
    cacheWrite1hTokens: addOptional(
      current.cacheWrite1hTokens,
      incoming.cacheWrite1hTokens
    ),
    reasoningTokens: addOptional(
      current.reasoningTokens,
      incoming.reasoningTokens
    ),
    totalTokens: addOptional(current.totalTokens, incoming.totalTokens),
    source
  };
}

export function aggregateModelUsage(
  attempts: ProviderAttempt[]
): AggregatedModelUsage {
  const sources = new Set<ModelUsage["source"]>();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let cacheWrite1hTokens: number | undefined;
  let reasoningTokens: number | undefined;
  let totalTokens: number | undefined;
  let unknownUsageAttemptCount = 0;

  for (const attempt of attempts) {
    if (!hasUsageValues(attempt.usage) || attempt.usage.source === "unknown") {
      unknownUsageAttemptCount += 1;
      continue;
    }
    sources.add(attempt.usage.source);
    inputTokens = addOptional(inputTokens, attempt.usage.inputTokens);
    outputTokens = addOptional(outputTokens, attempt.usage.outputTokens);
    cachedInputTokens = addOptional(
      cachedInputTokens,
      attempt.usage.cachedInputTokens
    );
    cacheWriteTokens = addOptional(
      cacheWriteTokens,
      attempt.usage.cacheWriteTokens
    );
    cacheWrite1hTokens = addOptional(
      cacheWrite1hTokens,
      attempt.usage.cacheWrite1hTokens
    );
    reasoningTokens = addOptional(
      reasoningTokens,
      attempt.usage.reasoningTokens
    );
    const attemptTotal =
      attempt.usage.totalTokens ??
      (attempt.usage.inputTokens !== undefined &&
      attempt.usage.outputTokens !== undefined
        ? attempt.usage.inputTokens + attempt.usage.outputTokens
        : undefined);
    if (attemptTotal === undefined) {
      unknownUsageAttemptCount += 1;
    } else {
      totalTokens = addOptional(totalTokens, attemptTotal);
    }
  }

  const source =
    sources.size === 0
      ? "unknown"
      : sources.size > 1
        ? "mixed"
        : [...sources][0];
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    cacheWrite1hTokens,
    reasoningTokens,
    totalTokens,
    source,
    attemptCount: attempts.length,
    succeededAttemptCount: attempts.filter(
      (attempt) => attempt.status === "succeeded"
    ).length,
    failedAttemptCount: attempts.filter(
      (attempt) => attempt.status === "failed"
    ).length,
    cancelledAttemptCount: attempts.filter(
      (attempt) => attempt.status === "cancelled"
    ).length,
    unknownUsageAttemptCount
  };
}
