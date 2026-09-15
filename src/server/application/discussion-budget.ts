import { attemptCost } from "@/server/application/model-pricing";
import type {
  AppState,
  Discussion,
  DiscussionBudget
} from "@/server/domain/types";

export type BudgetDimensionState =
  | "unbounded"
  | "ok"
  | "soft"
  | "hard"
  | "unknown";

export type BudgetDecision = "proceed" | "soft_stop" | "hard_stop";

export type DiscussionBudgetEvaluation = {
  source: "discussion" | "workspace_defaults" | "none";
  budget: DiscussionBudget;
  tokens: {
    used: number;
    soft?: number;
    hard?: number;
    remaining?: number;
    nextCallEstimate?: number;
    unknownUsageAttemptCount: number;
    state: BudgetDimensionState;
  };
  cost: {
    usedMicros: number;
    currency?: string;
    softMicros?: number;
    hardMicros?: number;
    remainingMicros?: number;
    unknownCostAttemptCount: number;
    state: BudgetDimensionState;
  };
  decision: BudgetDecision;
};

export type DiscussionTotalBudgetViolation = {
  dimension: "tokens" | "cost";
  used: number;
  limit: number;
  nextCallEstimate?: number;
  decision: "soft" | "hard";
};

export class DiscussionTotalBudgetError extends Error {
  readonly code = "discussion_budget_exhausted";
  readonly details: DiscussionTotalBudgetViolation;

  constructor(details: DiscussionTotalBudgetViolation) {
    super(
      `Discussion ${details.dimension} budget exhausted (used ${details.used} of ${details.limit})`
    );
    this.name = "DiscussionTotalBudgetError";
    this.details = details;
  }
}

function dimensionState(
  used: number,
  soft: number | undefined,
  hard: number | undefined,
  projected: number,
  unknownCount: number,
  knownCount: number
): BudgetDimensionState {
  if (hard === undefined && soft === undefined) return "unbounded";
  if (hard !== undefined && (used >= hard || projected > hard)) return "hard";
  if (soft !== undefined && used >= soft) return "soft";
  if (unknownCount > 0 && knownCount === 0) return "unknown";
  return "ok";
}

/**
 * Evaluates the Discussion's total token and cost budget against the
 * Provider attempts recorded for it. Limits resolve from the Discussion
 * budget, falling back to Workspace defaults. Unknown usage or pricing
 * never counts as zero: it is reported as unknown coverage and does not
 * by itself block execution.
 */
export function evaluateDiscussionBudget(
  state: Pick<AppState, "providerAttempts" | "modelPricing" | "workspace">,
  discussion: Discussion,
  options: { nextCallTokenEstimate?: number } = {}
): DiscussionBudgetEvaluation {
  const budget =
    discussion.budget ?? state.workspace.discussionBudgetDefaults ?? {};
  const source = discussion.budget
    ? "discussion"
    : state.workspace.discussionBudgetDefaults
      ? "workspace_defaults"
      : "none";
  const attempts = state.providerAttempts.filter(
    (attempt) => attempt.discussionId === discussion.id
  );

  let usedTokens = 0;
  let unknownUsageAttemptCount = 0;
  for (const attempt of attempts) {
    const total =
      attempt.usage.totalTokens ??
      (attempt.usage.inputTokens !== undefined &&
      attempt.usage.outputTokens !== undefined
        ? attempt.usage.inputTokens + attempt.usage.outputTokens
        : undefined);
    if (attempt.usage.source === "unknown" || total === undefined) {
      unknownUsageAttemptCount += 1;
      continue;
    }
    usedTokens += total;
  }

  let usedCostMicros = 0;
  let unknownCostAttemptCount = 0;
  const costLimited =
    budget.maxTotalCostMicros !== undefined ||
    budget.softTotalCostMicros !== undefined;
  for (const attempt of attempts) {
    const cost = attemptCost(state, attempt);
    if (cost === null || (budget.currency && cost.currency !== budget.currency)) {
      unknownCostAttemptCount += 1;
      continue;
    }
    usedCostMicros += cost.costMicros;
  }

  const nextCallTokenEstimate = options.nextCallTokenEstimate;
  const tokensState = dimensionState(
    usedTokens,
    budget.softTotalTokens,
    budget.maxTotalTokens,
    usedTokens + (nextCallTokenEstimate ?? 0),
    unknownUsageAttemptCount,
    attempts.length - unknownUsageAttemptCount
  );
  const costState = costLimited
    ? dimensionState(
        usedCostMicros,
        budget.softTotalCostMicros,
        budget.maxTotalCostMicros,
        usedCostMicros,
        unknownCostAttemptCount,
        attempts.length - unknownCostAttemptCount
      )
    : "unbounded";

  const decision: BudgetDecision =
    tokensState === "hard" || costState === "hard"
      ? "hard_stop"
      : tokensState === "soft" || costState === "soft"
        ? "soft_stop"
        : "proceed";

  return {
    source,
    budget,
    tokens: {
      used: usedTokens,
      soft: budget.softTotalTokens,
      hard: budget.maxTotalTokens,
      remaining:
        budget.maxTotalTokens !== undefined
          ? Math.max(0, budget.maxTotalTokens - usedTokens)
          : undefined,
      nextCallEstimate: nextCallTokenEstimate,
      unknownUsageAttemptCount,
      state: tokensState
    },
    cost: {
      usedMicros: usedCostMicros,
      currency: budget.currency,
      softMicros: budget.softTotalCostMicros,
      hardMicros: budget.maxTotalCostMicros,
      remainingMicros:
        budget.maxTotalCostMicros !== undefined
          ? Math.max(0, budget.maxTotalCostMicros - usedCostMicros)
          : undefined,
      unknownCostAttemptCount,
      state: costState
    },
    decision
  };
}

/**
 * Throws when the next Provider call must be rejected without executing:
 * a hard limit that is already met, or one the projected call would
 * exceed. Soft thresholds do not throw here; callers stop scheduling
 * further Turns instead.
 */
export function assertDiscussionBudgetForNextCall(
  evaluation: DiscussionBudgetEvaluation
): void {
  const { tokens, cost } = evaluation;
  if (tokens.hard !== undefined) {
    const projected = tokens.used + (tokens.nextCallEstimate ?? 0);
    if (tokens.used >= tokens.hard || projected > tokens.hard) {
      throw new DiscussionTotalBudgetError({
        dimension: "tokens",
        used: tokens.used,
        limit: tokens.hard,
        nextCallEstimate: tokens.nextCallEstimate,
        decision: "hard"
      });
    }
  }
  if (cost.hardMicros !== undefined && cost.usedMicros >= cost.hardMicros) {
    throw new DiscussionTotalBudgetError({
      dimension: "cost",
      used: cost.usedMicros,
      limit: cost.hardMicros,
      decision: "hard"
    });
  }
}

/**
 * Field-wise merge of an inherited budget with explicit overrides.
 * Returns undefined when the result carries no limits at all.
 */
export function mergeDiscussionBudget(
  base: DiscussionBudget | undefined,
  override: DiscussionBudget | undefined
): DiscussionBudget | undefined {
  const merged: DiscussionBudget = { ...base, ...override };
  for (const key of Object.keys(merged) as Array<keyof DiscussionBudget>) {
    if (merged[key] === undefined) delete merged[key];
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export type BudgetStopKind = "soft" | "hard";

export function budgetDimension(
  evaluation: DiscussionBudgetEvaluation
): "tokens" | "cost" {
  return evaluation.tokens.state === "soft" ||
    evaluation.tokens.state === "hard"
    ? "tokens"
    : "cost";
}

/**
 * Single payload shape for every `discussion_budget_exhausted` event so
 * Run-level and Round-level enforcement stay schema-compatible.
 */
export function budgetExhaustedPayload(input: {
  roundId?: string;
  runId?: string;
  dimension: "tokens" | "cost";
  decision: BudgetStopKind;
  evaluation: DiscussionBudgetEvaluation;
  violation?: {
    used: number;
    limit: number;
    nextCallEstimate?: number;
  };
}) {
  return {
    roundId: input.roundId,
    runId: input.runId,
    dimension: input.dimension,
    decision: input.decision,
    usedTokens: input.evaluation.tokens.used,
    softTotalTokens: input.evaluation.tokens.soft,
    maxTotalTokens: input.evaluation.tokens.hard,
    usedCostMicros: input.evaluation.cost.usedMicros,
    softTotalCostMicros: input.evaluation.cost.softMicros,
    maxTotalCostMicros: input.evaluation.cost.hardMicros,
    currency: input.evaluation.cost.currency,
    unknownUsageAttemptCount:
      input.evaluation.tokens.unknownUsageAttemptCount,
    unknownCostAttemptCount: input.evaluation.cost.unknownCostAttemptCount,
    ...(input.violation ? { violation: input.violation } : {})
  };
}
