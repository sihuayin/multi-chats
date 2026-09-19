import {
  aggregateAttemptCosts,
  attemptCost,
  type AttemptCostAggregate
} from "@/server/application/model-pricing";
import {
  conversationHref,
  discussionHref,
  runHref,
  taskHref
} from "@/server/application/view-links";
import {
  aggregateModelUsage,
  type AggregatedModelUsage
} from "@/server/application/model-usage";
import { evaluateDiscussionBudget } from "@/server/application/discussion-budget";
import type {
  AppState,
  Conversation,
  Discussion,
  ModelUsage,
  ProviderAttempt,
  Run,
  Task
} from "@/server/domain/types";
import {
  costIn,
  DEFAULT_USAGE_WINDOW,
  usageWindowHours,
  type UsageAttempt,
  type UsageBreakdownEntry,
  type UsageConversationBreakdown,
  type UsageDiscussionBreakdown,
  type UsageDiscussionBudget,
  type UsageModelBreakdown,
  type UsageProviderBreakdown,
  type UsageSeriesPoint,
  type UsageTaskBreakdown,
  type UsageTokenTotals,
  type UsageView,
  type UsageWindow
} from "@/lib/usage-view";

export type UsageViewOptions = {
  window?: UsageWindow;
  clock?: () => Date;
};

/** Opaque Map key; never parsed back apart. */
const GROUP_KEY_SEPARATOR = "\u0000";

type AttemptSummary = {
  attemptCount: number;
  usage: AggregatedModelUsage;
  cost: AttemptCostAggregate;
};

function summarize(
  state: AppState,
  attempts: ProviderAttempt[]
): AttemptSummary {
  return {
    attemptCount: attempts.length,
    usage: aggregateModelUsage(attempts),
    cost: aggregateAttemptCosts(state, attempts)
  };
}

/** Reads the token fields a per-attempt usage and an aggregate share. */
function tokenTotals(
  usage: ModelUsage | AggregatedModelUsage
): UsageTokenTotals {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    source: usage.source
  };
}

function breakdownEntry(summary: AttemptSummary): UsageBreakdownEntry {
  return {
    tokens: tokenTotals(summary.usage),
    costTotals: summary.cost.totals
  };
}

type Lookups = {
  runs: Map<string, Run>;
  discussions: Map<string, Discussion>;
  conversations: Map<string, Conversation>;
  tasks: Map<string, Task>;
};

function lookupsOf(state: AppState): Lookups {
  return {
    runs: new Map(state.runs.map((run) => [run.id, run])),
    discussions: new Map(
      state.discussions.map((discussion) => [discussion.id, discussion])
    ),
    conversations: new Map(
      state.conversations.map((conversation) => [conversation.id, conversation])
    ),
    tasks: new Map(state.tasks.map((task) => [task.id, task]))
  };
}

/**
 * An attempt belongs to its Run where it has one; a model re-ranking attempt
 * carries no Run, so it belongs to its Discussion instead. Both the
 * Conversation roll-up and the deep links read that precedence from here.
 */
function runOrDiscussionOf(
  attempt: ProviderAttempt,
  lookups: Lookups
): { run?: Run; discussion?: Discussion } {
  const run = attempt.runId ? lookups.runs.get(attempt.runId) : undefined;
  if (run) return { run };
  const discussion = attempt.discussionId
    ? lookups.discussions.get(attempt.discussionId)
    : undefined;
  return discussion ? { discussion } : {};
}

function conversationIdOf(
  attempt: ProviderAttempt,
  lookups: Lookups
): string | undefined {
  const { run, discussion } = runOrDiscussionOf(attempt, lookups);
  return run?.conversationId ?? discussion?.conversationId;
}

/**
 * Every Task an attempt accrues to: its Run's Task, plus both ends of its
 * Discussion's handoff. A Discussion whose source and confirmed Task are the
 * same yields it once.
 *
 * Both are read independently — unlike Conversation resolution, where the
 * Run simply supersedes the Discussion, an attempt may touch both. A
 * Discussion turn carries a Run *and* a Discussion, and only the Discussion
 * names the Tasks.
 */
function taskIdsOf(attempt: ProviderAttempt, lookups: Lookups): string[] {
  const taskIds = new Set<string>();
  const run = attempt.runId ? lookups.runs.get(attempt.runId) : undefined;
  if (run?.taskId) taskIds.add(run.taskId);
  const discussion = attempt.discussionId
    ? lookups.discussions.get(attempt.discussionId)
    : undefined;
  if (discussion?.sourceTaskId) taskIds.add(discussion.sourceTaskId);
  if (discussion?.confirmedTaskId) taskIds.add(discussion.confirmedTaskId);
  return [...taskIds];
}

/**
 * Groups attempts by a key, or by each of several keys when an attempt
 * belongs to more than one bucket — as it does for Tasks, where a
 * Discussion's spend counts under both ends of its handoff.
 */
function groupAttemptsByKey(
  attempts: ProviderAttempt[],
  keyOf: (attempt: ProviderAttempt) => string | string[] | undefined
): Map<string, ProviderAttempt[]> {
  const groups = new Map<string, ProviderAttempt[]>();
  for (const attempt of attempts) {
    const keys = keyOf(attempt);
    if (keys === undefined) continue;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const group = groups.get(key);
      if (group) {
        group.push(attempt);
      } else {
        groups.set(key, [attempt]);
      }
    }
  }
  return groups;
}

function discussionBudget(
  state: AppState,
  discussion: Discussion
): UsageDiscussionBudget | null {
  const evaluation = evaluateDiscussionBudget(state, discussion);
  if (evaluation.source === "none") return null;
  return {
    source: evaluation.source,
    tokens: {
      used: evaluation.tokens.used,
      soft: evaluation.tokens.soft,
      hard: evaluation.tokens.hard,
      unknownAttempts: evaluation.tokens.unknownUsageAttemptCount,
      state: evaluation.tokens.state
    },
    cost: {
      usedMicros: evaluation.cost.usedMicros,
      softMicros: evaluation.cost.softMicros,
      hardMicros: evaluation.cost.hardMicros,
      currency: evaluation.cost.currency,
      unknownAttempts: evaluation.cost.unknownCostAttemptCount,
      state: evaluation.cost.state
    }
  };
}

/**
 * Ranks a breakdown most expensive first. Cost is only comparable within a
 * currency, so cost ordering applies when the window holds a single
 * currency; otherwise total tokens — which carry no currency — order the
 * rows. The label settles the remaining ties.
 */
function sortedBreakdown<T extends UsageBreakdownEntry>(
  entries: T[],
  currency: string | null,
  label: (entry: T) => string
): T[] {
  return entries.sort((left, right) => {
    if (currency !== null) {
      const byCost = costIn(right, currency) - costIn(left, currency);
      if (byCost !== 0) return byCost;
    }
    const byTokens =
      (right.tokens.totalTokens ?? 0) - (left.tokens.totalTokens ?? 0);
    if (byTokens !== 0) return byTokens;
    return label(left).localeCompare(label(right));
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(stamp: number): string {
  return new Date(stamp).toISOString().slice(0, 10);
}

/**
 * One point per UTC calendar day the window touches, so a quiet day keeps
 * its place on the axis rather than letting its neighbours collapse
 * together. An all-time window starts at the earliest attempt rather than
 * at the epoch.
 *
 * A rolling window starts mid-day, so its leading bucket holds only the
 * attempts from `sinceMs` onward and is correspondingly short; every later
 * bucket is a whole day.
 *
 * Callers pass attempts whose start time already parses — the window filter
 * upstream is what decides that.
 */
function usageSeries(
  state: AppState,
  attempts: ProviderAttempt[],
  bounds: { sinceMs: number | null; nowMs: number }
): UsageSeriesPoint[] {
  const { sinceMs, nowMs } = bounds;
  const byDay = groupAttemptsByKey(attempts, (attempt) =>
    utcDay(Date.parse(attempt.startedAt))
  );

  // The series spans every day an attempt falls on, not merely up to the
  // clock: an attempt dated ahead of it is still counted in the totals, and
  // the series has to reconcile with them.
  let earliest = nowMs;
  let latest = nowMs;
  for (const attempt of attempts) {
    const startedAt = Date.parse(attempt.startedAt);
    if (startedAt < earliest) earliest = startedAt;
    if (startedAt > latest) latest = startedAt;
  }

  const startMs = Math.floor((sinceMs ?? earliest) / DAY_MS) * DAY_MS;
  const lastMs = Math.floor(latest / DAY_MS) * DAY_MS;
  const series: UsageSeriesPoint[] = [];
  for (let ms = startMs; ms <= lastMs; ms += DAY_MS) {
    const day = utcDay(ms);
    const group = byDay.get(day) ?? [];
    series.push({
      day,
      attemptCount: group.length,
      // Partial when the window's lower bound clips this day, or when the
      // day is today and today is not over yet.
      partial: (sinceMs !== null && sinceMs > ms) || nowMs < ms + DAY_MS,
      ...breakdownEntry(summarize(state, group))
    });
  }
  return series;
}

/** The drill-down list is capped; every total above still counts them all. */
const MAX_ATTEMPT_ROWS = 200;

function attemptHref(
  attempt: ProviderAttempt,
  lookups: Lookups
): string | undefined {
  const { run, discussion } = runOrDiscussionOf(attempt, lookups);
  if (run) return runHref(run);
  if (discussion) {
    return discussionHref(discussion.conversationId, discussion.id);
  }
  return undefined;
}

function attemptRows(
  state: AppState,
  attempts: ProviderAttempt[],
  lookups: Lookups
): UsageAttempt[] {
  return [...attempts]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, MAX_ATTEMPT_ROWS)
    .map((attempt) => {
      const href = attemptHref(attempt, lookups);
      return {
        id: attempt.id,
        provider: attempt.provider,
        modelId: attempt.modelId,
        purpose: attempt.purpose,
        status: attempt.status,
        tokens: tokenTotals(attempt.usage),
        cost: attemptCost(state, attempt),
        startedAt: attempt.startedAt,
        ...(href === undefined ? {} : { href })
      };
    });
}

/**
 * Rolls Provider-attempt usage and cost up to workspace totals, to per-Model,
 * per-Provider, per-Discussion, per-Conversation and per-Task breakdowns, and
 * to a daily series, over a window. Pure: reads only the given state, resolves no
 * I/O, and reuses the cost model rather than recomputing it.
 */
export function buildUsageView(
  state: AppState,
  options: UsageViewOptions = {}
): UsageView {
  const window = options.window ?? DEFAULT_USAGE_WINDOW;
  const now = (options.clock ?? (() => new Date()))();
  const nowMs = now.getTime();
  const hours = usageWindowHours(window);
  const sinceMs = hours === null ? null : nowMs - hours * 60 * 60_000;
  // The single point where the view decides which attempts it covers: an
  // attempt must be placeable in time, and inside the window. Every figure
  // below derives from this set, so the totals, the breakdowns and the
  // series cannot disagree about what is in scope.
  const attempts = state.providerAttempts.filter((attempt) => {
    const startedAt = Date.parse(attempt.startedAt);
    if (Number.isNaN(startedAt)) return false;
    return sinceMs === null || startedAt >= sinceMs;
  });

  const totals = summarize(state, attempts);
  const currency =
    totals.cost.totals.length === 1 ? totals.cost.totals[0].currency : null;
  const lookups = lookupsOf(state);

  const byModel: UsageModelBreakdown[] = sortedBreakdown(
    [
      ...groupAttemptsByKey(
        attempts,
        (attempt) =>
          `${attempt.provider}${GROUP_KEY_SEPARATOR}${attempt.modelId}`
      ).values()
    ].map((group) => ({
      provider: group[0].provider,
      modelId: group[0].modelId,
      ...breakdownEntry(summarize(state, group))
    })),
    currency,
    (entry) => `${entry.provider} ${entry.modelId}`
  );

  const byProvider: UsageProviderBreakdown[] = sortedBreakdown(
    [...groupAttemptsByKey(attempts, (attempt) => attempt.provider).values()].map(
      (group) => ({
        provider: group[0].provider,
        ...breakdownEntry(summarize(state, group))
      })
    ),
    currency,
    (entry) => entry.provider
  );

  const byDiscussion: UsageDiscussionBreakdown[] = sortedBreakdown(
    [
      ...groupAttemptsByKey(attempts, (attempt) => attempt.discussionId).entries()
    ].flatMap(([discussionId, group]) => {
      const discussion = lookups.discussions.get(discussionId);
      if (!discussion) return [];
      return [
        {
          discussionId,
          conversationId: discussion.conversationId,
          title: discussion.title,
          href: discussionHref(discussion.conversationId, discussion.id),
          budget: discussionBudget(state, discussion),
          ...breakdownEntry(summarize(state, group))
        }
      ];
    }),
    currency,
    (entry) => entry.title
  );

  const byConversation: UsageConversationBreakdown[] = sortedBreakdown(
    [
      ...groupAttemptsByKey(attempts, (attempt) =>
        conversationIdOf(attempt, lookups)
      ).entries()
    ].map(([conversationId, group]) => ({
      conversationId,
      title: lookups.conversations.get(conversationId)?.title ?? conversationId,
      href: conversationHref(conversationId),
      ...breakdownEntry(summarize(state, group))
    })),
    currency,
    (entry) => entry.title
  );

  const byTask: UsageTaskBreakdown[] = sortedBreakdown(
    [
      ...groupAttemptsByKey(attempts, (attempt) =>
        taskIdsOf(attempt, lookups)
      ).entries()
    ].map(([taskId, group]) => {
      const task = lookups.tasks.get(taskId);
      return {
        taskId,
        // A Task that no longer resolves keeps its spend visible, named by
        // its id, rather than vanishing from the panel.
        title: task?.title ?? taskId,
        ...(task ? { href: taskHref(task.conversationId, task.id) } : {}),
        ...breakdownEntry(summarize(state, group))
      };
    }),
    currency,
    (entry) => entry.title
  );

  // An attempt with unknown usage can never be priced, so every unknown-usage
  // attempt is already unpriced. Whatever remains unpriced beyond those is
  // spend whose model has no Pricing snapshot.
  const unknownUsageAttempts = totals.usage.unknownUsageAttemptCount;
  const unknownPricingAttempts =
    totals.attemptCount - totals.cost.pricedAttemptCount - unknownUsageAttempts;

  return {
    generatedAt: now.toISOString(),
    window: {
      kind: window,
      hours,
      ...(sinceMs === null ? {} : { since: new Date(sinceMs).toISOString() })
    },
    attemptCount: totals.attemptCount,
    tokens: tokenTotals(totals.usage),
    cost: {
      totals: totals.cost.totals,
      pricedAttemptCount: totals.cost.pricedAttemptCount
    },
    coverage: { unknownUsageAttempts, unknownPricingAttempts },
    byModel,
    byProvider,
    byDiscussion,
    byConversation,
    byTask,
    attempts: attemptRows(state, attempts, lookups),
    series: usageSeries(state, attempts, { sinceMs, nowMs }),
    empty: totals.attemptCount === 0
  };
}
