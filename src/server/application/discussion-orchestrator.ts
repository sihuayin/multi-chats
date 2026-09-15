import { ApiError, notFound } from "@/server/application/errors";
import {
  appendDiscussionEvent,
  type DiscussionEventFactory
} from "@/server/application/discussion-ledger";
import { validateDiscussion } from "@/server/application/discussion-domain";
import { createDiscussionBriefRevision } from "@/server/application/discussion-brief";
import { parseDiscussionBrief } from "@/server/application/discussion-brief";
import { mapDiscussionBriefToTask } from "@/server/application/discussion-task-handoff";
import { createDraftTask } from "@/server/application/task-factory";
import {
  budgetDimension,
  budgetExhaustedPayload,
  evaluateDiscussionBudget,
  mergeDiscussionBudget,
  type DiscussionBudgetEvaluation
} from "@/server/application/discussion-budget";
import {
  buildDiscussionRoundDetail,
  buildDiscussionView
} from "@/server/application/discussion-view";
import {
  CONVERGENCE_REQUIRED_QUIET_ROUNDS,
  contentAvailability,
  contentRounds,
  DEFAULT_DISCUSSION_CONTENT_ROUNDS,
  hasDiscussionConverged,
  latestTurnByEmployee,
  MAX_DISCUSSION_CONTENT_ROUNDS,
  nextDiscussionRoundNumber,
  phaseContext,
  phasePurpose,
  phaseRoundId
} from "@/server/application/discussion-protocol";
import { DISCUSSION_PROMPT_PROFILE_VERSION } from "@/server/application/discussion-prompts";
import type {
  ConversationRunService,
  StartPhaseRunResult
} from "@/server/application/conversation-run-service";
import type {
  AppState,
  Discussion,
  DiscussionBudget,
  DiscussionIntervention,
  DiscussionInterventionKind,
  DiscussionRound,
  DiscussionRoundPhase,
  Run
} from "@/server/domain/types";
import type { StateStore } from "@/server/store/store";
import {
  discussionConstraintsSchema,
  discussionCreateSchema,
  discussionInterventionCreateSchema,
  discussionPatchSchema,
  taskInputSchema
} from "@/server/domain/schemas";

type DiscussionRunPort = Pick<
  ConversationRunService,
  "startPhaseRun" | "cancelRun" | "getRunById"
>;

export {
  DEFAULT_DISCUSSION_CONTENT_ROUNDS,
  hasDiscussionConverged,
  MAX_DISCUSSION_CONTENT_ROUNDS
} from "@/server/application/discussion-protocol";

export type DiscussionOrchestratorOptions = {
  clock?: () => string;
  eventFactory?: DiscussionEventFactory;
  maxActiveDurationMs?: number;
  maxPhaseDurationMs?: number;
};

export type DiscussionStopInput = {
  reason?: string;
  operator?: string;
};

export type DiscussionRetryInput = {
  participantIds?: string[];
  reason?: string;
  operator?: string;
};

export type DiscussionSkipInput = {
  employeeId: string;
  reason?: string;
  operator?: string;
};

export type DiscussionSynthesizeInput = {
  force?: boolean;
  reason?: string;
  operator?: string;
};

export type DiscussionFacilitatorInput = {
  employeeId: string;
  reason?: string;
  operator?: string;
};

export type DiscussionConfirmInput = {
  briefArtifactId?: string;
  selectedOptionId?: string;
  taskTitle?: string;
  taskGoal?: string;
  assigneeIds?: string[];
  operator?: string;
};

type InterventionInput = Pick<
  DiscussionIntervention,
  "kind" | "content" | "idempotencyKey"
>;

function discussionById(state: AppState, discussionId: string): Discussion {
  const discussion = state.discussions.find((item) => item.id === discussionId);
  if (!discussion) notFound("Discussion");
  return discussion;
}

function incrementDiscussionRevision(discussion: Discussion): number {
  discussion.revision = (discussion.revision ?? 0) + 1;
  return discussion.revision;
}

function applyIntervention(
  discussion: Discussion,
  intervention: DiscussionIntervention,
  timestamp: string,
  eventFactory: DiscussionEventFactory
): void {
  if (intervention.status === "applied") return;
  const round = discussion.rounds.at(-1);
  intervention.status = "applied";
  intervention.appliedPhase = round?.phase;
  intervention.appliedRoundId = round?.id;
  intervention.resultingDiscussionRevision =
    incrementDiscussionRevision(discussion);
  intervention.appliedAt = timestamp;
  intervention.updatedAt = timestamp;

  if (intervention.kind === "constraint") {
    discussion.constraints = [
      ...new Set([
        ...(discussion.constraints ?? []),
        intervention.content
      ])
    ];
  } else if (intervention.kind === "question") {
    discussion.questions = [
      ...new Set([
        ...(discussion.questions ?? []),
        intervention.content
      ])
    ];
  } else if (intervention.kind === "focus") {
    discussion.note = intervention.content;
  }

  discussion.updatedAt = timestamp;
  appendDiscussionEvent(
    discussion,
    "intervention_applied",
    {
      interventionId: intervention.id,
      kind: intervention.kind,
      content: intervention.content,
      appliedPhase: intervention.appliedPhase,
      appliedRoundId: intervention.appliedRoundId,
      resultingDiscussionRevision:
        intervention.resultingDiscussionRevision
    },
    eventFactory
  );
}

function queueIntervention(
  discussion: Discussion,
  intervention: DiscussionIntervention,
  timestamp: string,
  eventFactory: DiscussionEventFactory
): void {
  intervention.status = "pending";
  intervention.updatedAt = timestamp;
  discussion.updatedAt = timestamp;
  appendDiscussionEvent(
    discussion,
    "intervention_queued",
    {
      interventionId: intervention.id,
      kind: intervention.kind,
      content: intervention.content
    },
    eventFactory
  );
}

function applyPendingInterventionsInState(
  state: AppState,
  discussion: Discussion,
  timestamp: string,
  eventFactory: DiscussionEventFactory
): number {
  const pending = state.discussionInterventions
    .filter(
      (intervention) =>
        intervention.discussionId === discussion.id &&
        intervention.status === "pending"
    )
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
  for (const intervention of pending) {
    applyIntervention(discussion, intervention, timestamp, eventFactory);
  }
  return pending.length;
}

function pendingInterventionCount(
  state: AppState,
  discussionId: string
): number {
  return state.discussionInterventions.filter(
    (item) =>
      item.discussionId === discussionId && item.status === "pending"
  ).length;
}

const MAX_ADVISORY_CONVERGENCE_REASONS = 10;

function advisoryConvergenceSummary(discussion: Discussion): {
  advisoryRecommendationCount: number;
  advisoryReasons: string[];
} {
  const advisoryTurns = discussion.rounds
    .filter(
      (item) =>
        item.phase === "cross_response" && item.status === "completed"
    )
    .flatMap((item) => item.turns)
    .filter((turn) => turn.payload?.convergence?.recommended === true);
  return {
    advisoryRecommendationCount: advisoryTurns.length,
    advisoryReasons: advisoryTurns
      .flatMap((turn) => turn.payload?.convergence?.reasons ?? [])
      .slice(0, MAX_ADVISORY_CONVERGENCE_REASONS)
  };
}

function activeRunInState(
  state: AppState,
  discussion: Discussion
): Run | undefined {
  const round = discussion.rounds.at(-1);
  if (!round?.runId) return undefined;
  return state.runs.find(
    (run) =>
      run.id === round.runId &&
      ["queued", "running", "waiting_approval"].includes(run.status)
  );
}

function applyLifecycleIntervention(
  state: AppState,
  discussion: Discussion,
  kind: DiscussionInterventionKind,
  content: string,
  timestamp: string,
  eventFactory: DiscussionEventFactory
): DiscussionIntervention {
  const intervention: DiscussionIntervention = {
    id: crypto.randomUUID(),
    workspaceId: state.workspace.id,
    discussionId: discussion.id,
    kind,
    content,
    status: "pending",
    createdBy: "user",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.discussionInterventions.push(intervention);
  applyIntervention(discussion, intervention, timestamp, eventFactory);
  return intervention;
}

export class DiscussionOrchestrator {
  private readonly clock: () => string;
  private readonly eventFactory: DiscussionEventFactory;

  constructor(
    private readonly store: StateStore,
    private readonly runs: DiscussionRunPort,
    private readonly options: DiscussionOrchestratorOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.eventFactory = {
      ...options.eventFactory,
      now: options.eventFactory?.now ?? this.clock
    };
  }

  async createDiscussion(
    conversationId: string,
    input: unknown
  ) {
    const parsed = discussionCreateSchema.parse(input);
    const discussionId = await this.store.update((state) => {
      const conversation = state.conversations.find(
        (item) => item.id === conversationId
      );
      if (!conversation) notFound("Conversation");
      if (
        state.discussions.some(
          (discussion) =>
            discussion.conversationId === conversationId &&
            ["draft", "running", "review", "interrupted"].includes(
              discussion.status
            )
        )
      ) {
        throw new ApiError(
          409,
          "Conversation already has an active Discussion",
          "discussion_active_conflict"
        );
      }
      const participants = parsed.participants.map(
        (participant, index) => {
          const employee = state.employees.find(
            (item) =>
              item.id === participant.employeeId && item.active
          );
          if (
            !employee ||
            !conversation.memberIds.includes(employee.id)
          ) {
            throw new ApiError(
              400,
              "Discussion Participants must be active Conversation Employees",
              "discussion_invalid_participants"
            );
          }
          return {
            id: crypto.randomUUID(),
            employeeId: participant.employeeId,
            role: participant.role,
            objective:
              participant.objective ??
              `Contribute to ${parsed.title} from your assigned role.`,
            order: index + 1
          };
        }
      );
      const facilitators = participants.filter(
        (participant) => participant.role === "facilitator"
      );
      if (
        facilitators.length !== 1 ||
        !participants.some(
          (participant) =>
            participant.role === "facilitator" &&
            participant.employeeId === parsed.facilitatorId
        )
      ) {
        throw new ApiError(
          400,
          "Discussion requires the selected Facilitator Participant",
          "discussion_invalid_participants"
        );
      }
      const timestamp = this.clock();
      const discussion: Discussion = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId,
        title: parsed.title,
        mode: parsed.mode,
        language: parsed.language,
        promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
        status: "draft",
        facilitatorParticipantId: facilitators[0].id,
        maxRounds: parsed.maxRounds,
        currentRound: 0,
        budget: mergeDiscussionBudget(
          state.workspace.discussionBudgetDefaults,
          parsed.budget
        ),
        sourceTaskId: parsed.sourceTaskId,
        participants,
        rounds: [],
        events: [],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.discussions.push(discussion);
      state.workspace.updatedAt = timestamp;
      return discussion.id;
    });
    return this.getDiscussionView(discussionId);
  }

  async updateDiscussion(
    discussionId: string,
    input: unknown
  ) {
    const parsed = discussionPatchSchema.parse(input);
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (
        discussion.status === "completed" ||
        discussion.status === "cancelled"
      ) {
        throw new ApiError(
          409,
          "Terminal Discussions cannot be edited",
          "discussion_invalid_state"
        );
      }
      if (activeRunInState(state, discussion)) {
        throw new ApiError(
          409,
          "Discussion configuration cannot change during an active Run",
          "discussion_active_conflict"
        );
      }
      const previousFacilitatorEmployeeId = discussion.participants.find(
        (participant) =>
          participant.id === discussion.facilitatorParticipantId
      )?.employeeId;
      if (parsed.participants) {
        const conversation = state.conversations.find(
          (item) => item.id === discussion.conversationId
        );
        if (!conversation) notFound("Conversation");
        discussion.participants = parsed.participants.map(
          (participant, index) => {
            const employee = state.employees.find(
              (item) =>
                item.id === participant.employeeId && item.active
            );
            if (
              !employee ||
              !conversation.memberIds.includes(employee.id)
            ) {
              throw new ApiError(
                400,
                "Discussion Participants must be active Conversation Employees",
                "discussion_invalid_participants"
              );
            }
            return {
              id:
                discussion.participants.find(
                  (existing) =>
                    existing.employeeId === participant.employeeId
                )?.id ?? crypto.randomUUID(),
              employeeId: participant.employeeId,
              role: participant.role,
              objective:
                participant.objective ??
                `Contribute to ${parsed.title ?? discussion.title} from your assigned role.`,
              order: index + 1
            };
          }
        );
      }
      if (parsed.title !== undefined) discussion.title = parsed.title;
      if (parsed.mode !== undefined) discussion.mode = parsed.mode;
      if (parsed.language !== undefined) {
        discussion.language = parsed.language;
      }
      if (parsed.maxRounds !== undefined) {
        discussion.maxRounds = parsed.maxRounds;
      }
      if (parsed.budget !== undefined) {
        discussion.budget = mergeDiscussionBudget(
          discussion.budget,
          parsed.budget
        );
      }
      const facilitatorEmployeeId =
        parsed.facilitatorId ??
        previousFacilitatorEmployeeId;
      const facilitator = discussion.participants.find(
        (participant) =>
          participant.employeeId === facilitatorEmployeeId &&
          participant.role === "facilitator"
      );
      if (
        !facilitator ||
        discussion.participants.filter(
          (participant) => participant.role === "facilitator"
        ).length !== 1
      ) {
        throw new ApiError(
          400,
          "Discussion requires the selected Facilitator Participant",
          "discussion_invalid_participants"
        );
      }
      discussion.facilitatorParticipantId = facilitator.id;
      const timestamp = this.clock();
      const lifecycleInputs: InterventionInput[] = [
        ...(parsed.mode !== undefined
          ? [
              {
                kind: "mode_change" as const,
                content: `Mode changed to ${parsed.mode}.`
              }
            ]
          : []),
        ...(parsed.participants !== undefined ||
        parsed.facilitatorId !== undefined
          ? [
              {
                kind: "participant_change" as const,
                content: "Discussion Participants were changed."
              }
            ]
          : []),
        ...(parsed.maxRounds !== undefined
          ? [
              {
                kind: "budget_change" as const,
                content: `Maximum content rounds changed to ${parsed.maxRounds}.`
              }
            ]
          : []),
        ...(parsed.budget !== undefined
          ? [
              {
                kind: "budget_change" as const,
                content: "Token and cost budget updated."
              }
            ]
          : [])
      ];
      for (const input of lifecycleInputs) {
        applyLifecycleIntervention(
          state,
          discussion,
          input.kind,
          input.content,
          timestamp,
          this.eventFactory
        );
      }
      if (lifecycleInputs.length > 0 && discussion.status === "review") {
        discussion.status = "interrupted";
        appendDiscussionEvent(
          discussion,
          "discussion_interrupted",
          {
            code: "intervention_requires_resynthesis"
          },
          this.eventFactory
        );
      }
      discussion.updatedAt = timestamp;
      state.workspace.updatedAt = discussion.updatedAt;
    });
    return this.getDiscussionView(discussionId);
  }

  async addConstraints(
    discussionId: string,
    input: unknown
  ) {
    const parsed = discussionConstraintsSchema.parse(input);
    const interventions: InterventionInput[] = [
      ...(parsed.constraints ?? []).map((content) => ({
        kind: "constraint" as const,
        content
      })),
      ...(parsed.questions ?? []).map((content) => ({
        kind: "question" as const,
        content
      })),
      ...(parsed.note
        ? [{ kind: "focus" as const, content: parsed.note }]
        : [])
    ];
    return this.addInterventions(discussionId, interventions);
  }

  async addIntervention(
    discussionId: string,
    input: unknown,
    options: { idempotencyKey?: string } = {}
  ) {
    return this.addInterventions(discussionId, [
      {
        ...discussionInterventionCreateSchema.parse(input),
        idempotencyKey: options.idempotencyKey
      }
    ]);
  }

  private async addInterventions(
    discussionId: string,
    inputs: InterventionInput[]
  ) {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (
        discussion.status === "completed" ||
        discussion.status === "cancelled"
      ) {
        throw new ApiError(
          409,
          "Terminal Discussions cannot accept interventions",
          "discussion_invalid_state"
        );
      }
      const timestamp = this.clock();
      const latestRound = discussion.rounds.at(-1);
      const activeRun = activeRunInState(state, discussion);
      const pending = Boolean(
        activeRun ||
          state.discussionInterventions.some(
            (intervention) =>
              intervention.discussionId === discussion.id &&
              intervention.status === "pending"
          ) ||
          discussion.status === "running" ||
          latestRound?.status === "running" ||
          latestRound?.phase === "synthesis"
      );
      for (const input of inputs) {
        const intervention: DiscussionIntervention = {
          id: crypto.randomUUID(),
          workspaceId: state.workspace.id,
          discussionId: discussion.id,
          kind: input.kind,
          content: input.content,
          status: "pending",
          createdBy: "user",
          idempotencyKey: input.idempotencyKey,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        state.discussionInterventions.push(intervention);
        if (pending) {
          queueIntervention(
            discussion,
            intervention,
            timestamp,
            this.eventFactory
          );
        } else {
          applyIntervention(
            discussion,
            intervention,
            timestamp,
            this.eventFactory
          );
          if (discussion.status === "review") {
            discussion.status = "interrupted";
            appendDiscussionEvent(
              discussion,
              "discussion_interrupted",
              {
                code: "intervention_requires_resynthesis",
                interventionId: intervention.id
              },
              this.eventFactory
            );
          }
        }
      }
      state.workspace.updatedAt = timestamp;
    });
    return this.getDiscussionView(discussionId);
  }

  async extendDiscussion(
    discussionId: string,
    input: { budget?: DiscussionBudget } = {}
  ) {
    const extension = await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status !== "review") {
        throw new ApiError(
          409,
          "Only Discussions in review can be extended",
          "discussion_invalid_state"
        );
      }
      const usedContentRounds = contentRounds(discussion.rounds).length;
      if (usedContentRounds >= 5) {
        throw new ApiError(
          409,
          "Discussion reached the absolute content-round limit",
          "discussion_budget_exhausted"
        );
      }
      const timestamp = this.clock();
      applyPendingInterventionsInState(
        state,
        discussion,
        timestamp,
        this.eventFactory
      );
      if (input.budget !== undefined) {
        discussion.budget = mergeDiscussionBudget(
          discussion.budget,
          input.budget
        );
        applyLifecycleIntervention(
          state,
          discussion,
          "budget_change",
          "Budget was raised while extending the Discussion.",
          timestamp,
          this.eventFactory
        );
      }
      applyLifecycleIntervention(
        state,
        discussion,
        "extension",
        "One additional Cross-response Round was added.",
        timestamp,
        this.eventFactory
      );
      const round: DiscussionRound = {
        id: phaseRoundId(
          discussion.id,
          nextDiscussionRoundNumber(discussion.rounds),
          "cross_response"
        ),
        roundNumber: nextDiscussionRoundNumber(discussion.rounds),
        phase: "cross_response",
        status: "pending",
        participantSnapshot: structuredClone(discussion.participants),
        turns: [],
        createdAt: timestamp
      };
      discussion.rounds.push(round);
      discussion.currentRound = usedContentRounds;
      discussion.currentRound += 1;
      discussion.status = "running";
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "discussion_resumed",
        {
          operation: "extend",
          roundId: round.id,
          roundNumber: round.roundNumber
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
      return round.id;
    });
    await this.startPreparedPhase(discussionId, {
      expectedRoundId: extension
    });
    return this.getDiscussionView(discussionId);
  }

  async getDiscussionView(discussionId: string) {
    return this.store.read((state) =>
      buildDiscussionView(state, discussionId)
    );
  }

  async listDiscussionViews(conversationId: string) {
    return this.store.read((state) => {
      if (
        !state.conversations.some(
          (conversation) => conversation.id === conversationId
        )
      ) {
        notFound("Conversation");
      }
      return state.discussions
        .filter(
          (discussion) => discussion.conversationId === conversationId
        )
        .map((discussion) => buildDiscussionView(state, discussion.id));
    });
  }

  async getDiscussionRound(
    discussionId: string,
    roundId: string
  ) {
    return this.store.read((state) =>
      buildDiscussionRoundDetail(state, discussionId, roundId)
    );
  }

  async listDiscussionEvents(
    discussionId: string,
    afterSequence = 0
  ) {
    return this.store.read((state) => {
      const discussion = discussionById(state, discussionId);
      return (discussion.events ?? [])
        .filter((event) => event.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence);
    });
  }

  async startDiscussion(discussionId: string): Promise<Discussion> {
    const started = await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status === "running") return structuredClone(discussion);
      if (discussion.status !== "draft") {
        throw new ApiError(
          409,
          "Only draft Discussions can be started",
          "discussion_invalid_state"
        );
      }
      if (
        state.discussions.some(
          (item) =>
            item.id !== discussion.id &&
            item.conversationId === discussion.conversationId &&
            ["draft", "running", "review", "interrupted"].includes(
              item.status
            )
        )
      ) {
        throw new ApiError(
          409,
          "Conversation already has an active Discussion",
          "discussion_active_conflict"
        );
      }
      discussion.maxRounds ??= DEFAULT_DISCUSSION_CONTENT_ROUNDS;
      discussion.promptProfileVersion =
        DISCUSSION_PROMPT_PROFILE_VERSION;
      if (discussion.maxRounds > MAX_DISCUSSION_CONTENT_ROUNDS) {
        throw new ApiError(
          409,
          "Discussion exceeds the maximum content-round budget",
          "discussion_budget_exhausted"
        );
      }
      try {
        validateDiscussion(discussion);
      } catch {
        throw new ApiError(
          409,
          "Discussion configuration is invalid",
          "discussion_invalid_state"
        );
      }
      const timestamp = this.clock();
      discussion.status = "running";
      discussion.startedAt ??= timestamp;
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "discussion_started",
        {},
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
      return structuredClone(discussion);
    });
    await this.advanceDiscussion(started.id);
    return this.getDiscussion(started.id);
  }

  async advanceDiscussion(discussionId: string): Promise<Discussion> {
    for (let step = 0; step < 10; step += 1) {
      const decision = await this.store.read((state) => {
        const discussion = discussionById(state, discussionId);
        if (discussion.status !== "running") {
          return { kind: "stop" as const };
        }
        const latest = discussion.rounds.at(-1);
        if (!latest) {
          return { kind: "positions" as const };
        }
        if (latest.status === "pending") {
          return { kind: "start" as const };
        }
        if (latest.status === "running" && latest.runId) {
          return { kind: "settle" as const };
        }
        if (latest.status !== "completed") {
          return { kind: "stop" as const };
        }
        if (latest.phase === "synthesis") {
          return { kind: "review" as const };
        }
        return {
          kind: "next" as const,
          discussion: structuredClone(discussion),
          budget: evaluateDiscussionBudget(state, discussion),
          converged: hasDiscussionConverged(discussion.rounds, {
            pendingInterventions: pendingInterventionCount(
              state,
              discussion.id
            )
          })
        };
      });

      if (decision.kind === "stop") break;
      if (decision.kind === "positions") {
        await this.preparePhase(discussionId, 1, "positions");
        continue;
      }
      if (decision.kind === "start") {
        await this.startPreparedPhase(discussionId);
        continue;
      }
      if (decision.kind === "settle") {
        if ((await this.settleLatestRun(discussionId)) !== "completed") {
          if (await this.transitionIfBudgetExhausted(discussionId)) {
            continue;
          }
          break;
        }
        continue;
      }
      if (decision.kind === "review") {
        await this.moveToReview(discussionId);
        break;
      }

      const discussion = decision.discussion;
      const latest = discussion.rounds.at(-1)!;
      const contentRounds = discussion.rounds.filter(
        (round) => round.phase !== "synthesis"
      );
      if (latest.phase === "positions") {
        if (contentRounds.length >= discussion.maxRounds) {
          await this.prepareSynthesis(discussionId, latest);
        } else if (decision.budget.decision !== "proceed") {
          await this.transitionBudgetExhausted(discussionId, latest, decision.budget);
        } else {
          await this.preparePhase(
            discussionId,
            contentRounds.length + 1,
            "cross_response"
          );
        }
        continue;
      }
      if (contentRounds.length >= discussion.maxRounds) {
        await this.prepareSynthesis(discussionId, latest);
        continue;
      }
      if (decision.budget.decision !== "proceed") {
        await this.transitionBudgetExhausted(discussionId, latest, decision.budget);
        continue;
      }
      if (decision.converged) {
        await this.prepareSynthesis(discussionId, latest);
        continue;
      }
      await this.preparePhase(
        discussionId,
        contentRounds.length + 1,
        "cross_response"
      );
    }
    return this.getDiscussion(discussionId);
  }

  async getDiscussion(discussionId: string): Promise<Discussion> {
    return this.store.read((state) =>
      structuredClone(discussionById(state, discussionId))
    );
  }

  async stopDiscussion(
    discussionId: string,
    input: DiscussionStopInput = {}
  ): Promise<Discussion> {
    const activeRun = await this.activeRun(discussionId);
    if (activeRun) await this.runs.cancelRun(activeRun.id);
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (
        discussion.status === "completed" ||
        discussion.status === "cancelled"
      ) {
        throw new ApiError(
          409,
          "Terminal Discussions cannot be stopped",
          "discussion_invalid_state"
        );
      }
      const timestamp = this.clock();
      applyLifecycleIntervention(
        state,
        discussion,
        "stop",
        input.reason ?? "Discussion stopped by the user.",
        timestamp,
        this.eventFactory
      );
      discussion.status = "interrupted";
      discussion.updatedAt = timestamp;
      const round = discussion.rounds.at(-1);
      if (round && round.status !== "completed") {
        round.status = "interrupted";
      }
      appendDiscussionEvent(
        discussion,
        "discussion_stopped",
        {
          reason: input.reason,
          operator: input.operator ?? "user",
          roundId: round?.id,
          runId: round?.runId
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
    });
    return this.getDiscussion(discussionId);
  }

  async cancelDiscussion(
    discussionId: string,
    input: DiscussionStopInput = {}
  ): Promise<Discussion> {
    const activeRun = await this.activeRun(discussionId);
    if (activeRun) await this.runs.cancelRun(activeRun.id);
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status === "cancelled") {
        return structuredClone(discussion);
      }
      if (discussion.status === "completed") {
        throw new ApiError(
          409,
          "Completed Discussions cannot be cancelled",
          "discussion_invalid_state"
        );
      }
      const timestamp = this.clock();
      applyLifecycleIntervention(
        state,
        discussion,
        "cancel",
        input.reason ?? "Discussion cancelled by the user.",
        timestamp,
        this.eventFactory
      );
      discussion.status = "cancelled";
      discussion.completedAt = timestamp;
      discussion.updatedAt = timestamp;
      const round = discussion.rounds.at(-1);
      if (round && round.status !== "completed") {
        round.status = "cancelled";
        round.completedAt = timestamp;
      }
      appendDiscussionEvent(
        discussion,
        "discussion_cancelled",
        {
          reason: input.reason,
          operator: input.operator ?? "user",
          roundId: round?.id,
          runId: round?.runId
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
      return structuredClone(discussion);
    });
    return this.getDiscussion(discussionId);
  }

  async retryPhase(
    discussionId: string,
    input: DiscussionRetryInput = {}
  ): Promise<Discussion> {
    const activeRun = await this.activeRun(discussionId);
    if (activeRun) {
      throw new ApiError(
        409,
        "Discussion already has an active Run",
        "discussion_active_conflict"
      );
    }
    const retry = await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status !== "interrupted") {
        throw new ApiError(
          409,
          "Only interrupted Discussions can be retried",
          "discussion_invalid_state"
        );
      }
      const round = discussion.rounds.at(-1);
      if (!round) {
        throw new ApiError(
          409,
          "Discussion has no failed phase to retry",
          "discussion_not_ready"
        );
      }
      const requested = input.participantIds
        ? new Set(input.participantIds)
        : new Set(
            round.participantSnapshot
              .filter((participant) => {
                const latest = latestTurnByEmployee(
                  round,
                  participant.employeeId
                );
                return (
                  latest?.status !== "completed" &&
                  latest?.cancelReason !== "skipped_by_user"
                );
              })
              .map((participant) => participant.id)
          );
      const participants = (
        round.phase === "synthesis"
          ? round.participantSnapshot.filter(
              (participant) => participant.role === "facilitator"
            )
          : round.participantSnapshot
      ).filter((participant) => requested.has(participant.id));
      if (participants.length === 0) {
        throw new ApiError(
          409,
          "Discussion phase has no Participants to retry",
          "discussion_insufficient_turns"
        );
      }
      const facilitator = discussion.participants.find(
        (participant) =>
          participant.id === discussion.facilitatorParticipantId
      );
      if (
        participants.some(
          (participant) => participant.id === facilitator?.id
        ) &&
        !state.employees.some(
          (employee) =>
            employee.id === facilitator?.employeeId && employee.active
        )
      ) {
        throw new ApiError(
          409,
          "Facilitator is unavailable and must be replaced",
          "discussion_facilitator_unavailable"
        );
      }
      const timestamp = this.clock();
      applyPendingInterventionsInState(
        state,
        discussion,
        timestamp,
        this.eventFactory
      );
      discussion.promptProfileVersion =
        DISCUSSION_PROMPT_PROFILE_VERSION;
      round.status = "pending";
      round.completedAt = undefined;
      round.activeParticipantIds = participants.map(
        (participant) => participant.id
      );
      discussion.status = "running";
      discussion.completedAt = undefined;
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "discussion_resumed",
        {
          operation: "retry",
          reason: input.reason,
          operator: input.operator ?? "user",
          roundId: round.id,
          previousRunId: round.runId,
          participantIds: participants.map((participant) => participant.id)
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
      return { roundId: round.id };
    });
    await this.startPreparedPhase(discussionId, {
      retry: true,
      expectedRoundId: retry.roundId
    });
    return this.getDiscussion(discussionId);
  }

  async skipParticipant(
    discussionId: string,
    input: DiscussionSkipInput
  ): Promise<Discussion> {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status !== "interrupted") {
        throw new ApiError(
          409,
          "Participants can only be skipped while the Discussion is interrupted",
          "discussion_invalid_state"
        );
      }
      const round = discussion.rounds.at(-1);
      const participant = round?.participantSnapshot.find(
        (item) => item.employeeId === input.employeeId
      );
      const turn = round
        ? latestTurnByEmployee(round, input.employeeId)
        : undefined;
      if (!round || !participant || !turn) {
        notFound("Discussion Participant");
      }
      if (
        round.phase === "synthesis" &&
        participant.id === discussion.facilitatorParticipantId
      ) {
        throw new ApiError(
          409,
          "The Facilitator cannot be skipped",
          "discussion_facilitator_unavailable"
        );
      }
      const remainingParticipants = (
        round.activeParticipantIds ??
        round.participantSnapshot.map((item) => item.id)
      ).filter((id) => id !== participant.id);
      if (round.phase !== "synthesis" && remainingParticipants.length < 2) {
        throw new ApiError(
          409,
          "Skipping this Participant would violate minimum viable content",
          "discussion_insufficient_turns"
        );
      }
      if (
        round.phase === "cross_response" &&
        turn.status === "completed" &&
        (turn.payload || turn.content) &&
        contentAvailability(discussion.rounds).validCrossResponseTurns <= 1
      ) {
        throw new ApiError(
          409,
          "Skipping this Participant would remove the last valid Cross-response Turn",
          "discussion_insufficient_turns"
        );
      }
      const timestamp = this.clock();
      turn.status = "cancelled";
      turn.cancelReason = "skipped_by_user";
      turn.completedAt = timestamp;
      round.activeParticipantIds = remainingParticipants;
      round.status = "interrupted";
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "participant_skipped",
        {
          reason: input.reason ?? "skipped_by_user",
          operator: input.operator ?? "user",
          roundId: round.id,
          turnId: turn.id,
          participantId: participant.id,
          employeeId: participant.employeeId
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
    });
    return this.getDiscussion(discussionId);
  }

  async synthesize(
    discussionId: string,
    input: DiscussionSynthesizeInput = {}
  ): Promise<Discussion> {
    const activeRun = await this.activeRun(discussionId);
    if (activeRun) {
      throw new ApiError(
        409,
        "Discussion already has an active Run",
        "discussion_active_conflict"
      );
    }
    const synthesis = await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (
        discussion.status === "completed" ||
        discussion.status === "cancelled"
      ) {
        throw new ApiError(
          409,
          "Terminal Discussions cannot synthesize",
          "discussion_invalid_state"
        );
      }
      const availability = contentAvailability(discussion.rounds);
      if (
        !input.force &&
        (availability.validPositionParticipants < 2 ||
          availability.validCrossResponseTurns < 1)
      ) {
        throw new ApiError(
          409,
          "Discussion does not have enough valid turns to synthesize",
          "discussion_insufficient_turns"
        );
      }
      const facilitator = discussion.participants.find(
        (participant) =>
          participant.id === discussion.facilitatorParticipantId
      );
      if (
        !state.employees.some(
          (employee) =>
            employee.id === facilitator?.employeeId && employee.active
        )
      ) {
        throw new ApiError(
          409,
          "Facilitator is unavailable and must be replaced",
          "discussion_facilitator_unavailable"
        );
      }

      const timestamp = this.clock();
      applyPendingInterventionsInState(
        state,
        discussion,
        timestamp,
        this.eventFactory
      );
      discussion.promptProfileVersion =
        DISCUSSION_PROMPT_PROFILE_VERSION;
      let round = discussion.rounds.findLast(
        (item) => item.phase === "synthesis"
      );
      const retry = Boolean(round);
      if (!round) {
        round = {
          id: phaseRoundId(
            discussion.id,
            nextDiscussionRoundNumber(discussion.rounds),
            "synthesis"
          ),
          roundNumber: nextDiscussionRoundNumber(discussion.rounds),
          phase: "synthesis",
          status: "pending",
          participantSnapshot: structuredClone(discussion.participants),
          turns: [],
          createdAt: timestamp
        };
        discussion.rounds.push(round);
      } else {
        round.status = "pending";
        round.completedAt = undefined;
      }
      round.activeParticipantIds = [
        discussion.facilitatorParticipantId
      ];
      discussion.status = "running";
      discussion.completedAt = undefined;
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "discussion_resumed",
        {
          operation: "synthesize",
          reason: input.reason,
          operator: input.operator ?? "user",
          force: Boolean(input.force),
          roundId: round.id,
          previousRunId: round.runId,
          validTurns: availability
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
      return { roundId: round.id, retry };
    });
    await this.startPreparedPhase(discussionId, {
      retry: synthesis.retry,
      expectedRoundId: synthesis.roundId
    });
    return this.getDiscussion(discussionId);
  }

  async replaceFacilitator(
    discussionId: string,
    input: DiscussionFacilitatorInput
  ): Promise<Discussion> {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status !== "interrupted") {
        throw new ApiError(
          409,
          "Facilitator can only be replaced while the Discussion is interrupted",
          "discussion_invalid_state"
        );
      }
      const participant = discussion.participants.find(
        (item) => item.employeeId === input.employeeId
      );
      const employee = state.employees.find(
        (item) => item.id === input.employeeId && item.active
      );
      const conversation = state.conversations.find(
        (item) => item.id === discussion.conversationId
      );
      if (
        !participant ||
        !employee ||
        !conversation?.memberIds.includes(employee.id)
      ) {
        throw new ApiError(
          409,
          "Replacement Facilitator must be an active Participant",
          "discussion_facilitator_unavailable"
        );
      }
      const previous = discussion.participants.find(
        (item) => item.id === discussion.facilitatorParticipantId
      );
      const timestamp = this.clock();
      if (previous && previous.id !== participant.id) {
        previous.role = "analyst";
      }
      participant.role = "facilitator";
      discussion.facilitatorParticipantId = participant.id;
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "facilitator_replaced",
        {
          reason: input.reason,
          operator: input.operator ?? "user",
          previousFacilitatorId: previous?.id,
          facilitatorParticipantId: participant.id,
          employeeId: participant.employeeId
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
    });
    return this.getDiscussion(discussionId);
  }

  async confirmBrief(
    discussionId: string,
    input: DiscussionConfirmInput = {}
  ): Promise<{
    task: AppState["tasks"][number];
    discussion: Discussion;
  }> {
    const activeRun = await this.activeRun(discussionId);
    if (activeRun) {
      throw new ApiError(
        409,
        "Discussion already has an active Run",
        "discussion_active_conflict"
      );
    }
    return this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status !== "review") {
        throw new ApiError(
          409,
          "Only Discussions in review can be confirmed",
          "discussion_invalid_state"
        );
      }
      const latestBriefArtifactId = discussion.latestBriefArtifactId;
      if (!latestBriefArtifactId) {
        throw new ApiError(
          409,
          "Discussion does not have a Brief to confirm",
          "discussion_not_ready"
        );
      }
      const briefArtifactId =
        input.briefArtifactId ?? latestBriefArtifactId;
      if (briefArtifactId !== latestBriefArtifactId) {
        throw new ApiError(
          409,
          "Only the latest Brief revision can be confirmed",
          "discussion_invalid_state"
        );
      }
      const artifact = state.artifacts.find(
        (item) =>
          item.id === briefArtifactId &&
          item.kind === "discussion_brief" &&
          item.ownerType === "discussion" &&
          item.ownerId === discussion.id
      );
      if (!artifact) {
        throw new ApiError(
          409,
          "Discussion Brief revision was not found",
          "discussion_not_ready"
        );
      }
      const brief = parseDiscussionBrief(artifact.content);
      if (
        brief.discussionId !== discussion.id ||
        brief.mode !== discussion.mode
      ) {
        throw new ApiError(
          409,
          "Discussion Brief does not match the Discussion",
          "discussion_invalid_state"
        );
      }

      const conversation = state.conversations.find(
        (item) => item.id === discussion.conversationId
      );
      if (!conversation) notFound("Conversation");
      const activeParticipantEmployeeIds = discussion.participants
        .filter(
          (participant) =>
            conversation.memberIds.includes(participant.employeeId) &&
            state.employees.some(
              (employee) =>
                employee.id === participant.employeeId && employee.active
            )
        )
        .map((participant) => participant.employeeId);
      const facilitator = discussion.participants.find(
        (participant) =>
          participant.id === discussion.facilitatorParticipantId
      );
      if (
        input.assigneeIds === undefined &&
        (!facilitator ||
          !activeParticipantEmployeeIds.includes(
            facilitator.employeeId
          ))
      ) {
        throw new ApiError(
          409,
          "Facilitator is unavailable and must be replaced",
          "discussion_facilitator_unavailable"
        );
      }
      const defaultAssigneeIds = facilitator
        ? [facilitator.employeeId, ...activeParticipantEmployeeIds]
        : activeParticipantEmployeeIds;
      const assigneeIds = input.assigneeIds ?? defaultAssigneeIds;
      if (
        assigneeIds.length === 0 ||
        assigneeIds.some(
          (employeeId) =>
            !activeParticipantEmployeeIds.includes(employeeId)
        )
      ) {
        throw new ApiError(
          409,
          "Task assignees must be active Discussion Participants",
          "discussion_invalid_participants"
        );
      }
      const taskTitle = input.taskTitle?.trim();
      const taskGoal = input.taskGoal?.trim();
      if (
        (input.taskTitle !== undefined && !taskTitle) ||
        (input.taskGoal !== undefined && !taskGoal)
      ) {
        throw new ApiError(
          409,
          "Task title and goal must not be empty",
          "discussion_invalid_state"
        );
      }
      const mapped = mapDiscussionBriefToTask({
        brief,
        discussionTitle: discussion.title,
        selectedOptionId: input.selectedOptionId,
        taskTitle,
        taskGoal,
        assigneeIds
      });
      const parsedTask = taskInputSchema.parse({
        title: mapped.title,
        goal: mapped.goal,
        assigneeIds: mapped.assigneeIds
      });
      const timestamp = this.clock();
      const task = createDraftTask({
        workspaceId: state.workspace.id,
        conversationId: discussion.conversationId,
        title: parsedTask.title,
        goal: parsedTask.goal,
        assigneeIds: parsedTask.assigneeIds,
        discussionId: discussion.id,
        confirmedBriefArtifactId: artifact.id,
        now: timestamp
      });
      state.tasks.push(task);
      discussion.confirmedBriefArtifactId = artifact.id;
      discussion.confirmedTaskId = task.id;
      discussion.status = "completed";
      discussion.completedAt = timestamp;
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "discussion_confirmed",
        {
          confirmedBriefArtifactId: artifact.id,
          briefRevision: artifact.revision,
          selectedOptionId: mapped.selectedOptionId,
          confirmedTaskId: task.id,
          operator: input.operator ?? "user"
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
      return {
        task: structuredClone(task),
        discussion: structuredClone(discussion)
      };
    });
  }

  async recoverInterruptedDiscussions(): Promise<void> {
    await this.reconcileDiscussions();
  }

  async reconcileDiscussions(): Promise<void> {
    const discussions = await this.store.read((state) =>
      state.discussions
        .filter((discussion) => discussion.status === "running")
        .map((discussion) => ({
          id: discussion.id,
          startedAt: discussion.startedAt,
          roundId: discussion.rounds.at(-1)?.id,
          roundStartedAt: discussion.rounds.at(-1)?.startedAt
        }))
    );
    const currentTime = Date.parse(this.clock());
    for (const discussion of discussions) {
      const phaseTimedOut =
        discussion.roundStartedAt !== undefined &&
        currentTime - Date.parse(discussion.roundStartedAt) >=
          (this.options.maxPhaseDurationMs ?? 15 * 60_000);
      const totalTimedOut =
        discussion.startedAt !== undefined &&
        currentTime - Date.parse(discussion.startedAt) >=
          (this.options.maxActiveDurationMs ?? 60 * 60_000);
      if (phaseTimedOut || totalTimedOut) {
        const activeRun = await this.activeRun(discussion.id);
        if (activeRun) await this.runs.cancelRun(activeRun.id);
        const latest = await this.store.read((state) => {
          const value = discussionById(state, discussion.id);
          return value.rounds.find(
            (round) => round.id === discussion.roundId
          );
        });
        await this.interruptDiscussion(
          discussion.id,
          totalTimedOut
            ? "discussion_total_timeout"
            : "discussion_phase_timeout",
          latest
        );
        continue;
      }
      await this.advanceDiscussion(discussion.id);
    }
  }

  private async activeRun(discussionId: string): Promise<Run | null> {
    return this.store.read((state) => {
      const discussion = discussionById(state, discussionId);
      const round = discussion.rounds.at(-1);
      if (!round?.runId) return null;
      return (
        state.runs.find(
          (run) =>
            run.id === round.runId &&
            ["queued", "running", "waiting_approval"].includes(run.status)
        ) ?? null
      );
    });
  }

  private async preparePhase(
    discussionId: string,
    roundNumber: number,
    phase: DiscussionRoundPhase
  ): Promise<void> {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      const id = phaseRoundId(discussion.id, roundNumber, phase);
      if (discussion.rounds.some((round) => round.id === id)) return;
      const timestamp = this.clock();
      applyPendingInterventionsInState(
        state,
        discussion,
        timestamp,
        this.eventFactory
      );
      discussion.rounds.push({
        id,
        roundNumber,
        phase,
        status: "pending",
        participantSnapshot: structuredClone(discussion.participants),
        turns: [],
        createdAt: timestamp
      });
      discussion.currentRound = Math.max(
        discussion.currentRound,
        phase === "synthesis"
          ? discussion.currentRound
          : contentRounds(discussion.rounds).length
      );
      discussion.updatedAt = timestamp;
      state.workspace.updatedAt = timestamp;
    });
  }

  private async settleLatestRun(
    discussionId: string
  ): Promise<Run["status"] | null> {
    const latestRun = await this.store.read((state) => {
      const discussion = discussionById(state, discussionId);
      const round = discussion.rounds.at(-1);
      if (!round?.runId) return null;
      return state.runs.find((run) => run.id === round.runId) ?? null;
    });
    if (!latestRun) return null;
    if (
      !["completed", "failed", "cancelled", "interrupted"].includes(
        latestRun.status
      )
    ) {
      return latestRun.status;
    }

    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      const round = discussion.rounds.at(-1);
      if (!round || round.status !== "running") return;
      const timestamp = this.clock();
      const runMessages = state.messages.filter(
        (message) => message.runId === latestRun.id
      );
      round.status =
        latestRun.status === "completed"
          ? "completed"
          : latestRun.status === "cancelled"
            ? "cancelled"
            : latestRun.status === "failed"
              ? "failed"
              : "interrupted";
      round.completedAt = timestamp;
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        latestRun.status === "completed" ? "phase_completed" : "phase_failed",
        {
          roundId: round.id,
          roundNumber: round.roundNumber,
          phase: round.phase,
          runId: round.runId,
          status: latestRun.status,
          error: latestRun.error,
          messageIds: runMessages.map((message) => message.id),
          turnIds: runMessages
            .map((message) => message.discussionTurnId)
            .filter((id): id is string => Boolean(id))
        },
        this.eventFactory
      );
      if (latestRun.status === "completed" && round.phase === "synthesis") {
        const turn = round.turns
          .filter((item) => item.role === "facilitator")
          .sort(
            (left, right) =>
              (right.attempt ?? 1) - (left.attempt ?? 1)
          )[0];
        if (
          !turn ||
          turn.status !== "completed" ||
          !turn.content
        ) {
          throw new Error(
            "Synthesis did not produce a Discussion Brief"
          );
        }
        const { artifact } = createDiscussionBriefRevision(
          state,
          discussion,
          turn.content,
          {
            id: this.eventFactory.id,
            now: this.eventFactory.now
          }
        );
        appendDiscussionEvent(
          discussion,
          "brief_created",
          {
            artifactId: artifact.id,
            revision: artifact.revision,
            schemaVersion: artifact.schemaVersion,
            synthesisRoundId: round.id,
            runId: round.runId
          },
          this.eventFactory
        );
      }
      if (
        latestRun.status !== "completed" &&
        discussion.status !== "cancelled" &&
        latestRun.errorCode !== "discussion_budget_exhausted"
      ) {
        discussion.status = "interrupted";
        appendDiscussionEvent(
          discussion,
          "discussion_interrupted",
          {
            code:
              latestRun.status === "interrupted"
                ? "worker_restart"
                : "discussion_phase_failed",
            roundId: round.id,
            runId: round.runId
          },
          this.eventFactory
        );
      }
      state.workspace.updatedAt = timestamp;
    });
    return latestRun.status;
  }

  private async moveToReview(discussionId: string): Promise<void> {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status !== "running") return;
      const timestamp = this.clock();
      const applied = applyPendingInterventionsInState(
        state,
        discussion,
        timestamp,
        this.eventFactory
      );
      if (applied > 0) {
        discussion.status = "interrupted";
        discussion.updatedAt = timestamp;
        appendDiscussionEvent(
          discussion,
          "discussion_interrupted",
          {
            code: "intervention_requires_resynthesis"
          },
          this.eventFactory
        );
        state.workspace.updatedAt = timestamp;
        return;
      }
      discussion.status = "review";
      discussion.updatedAt = timestamp;
      appendDiscussionEvent(
        discussion,
        "discussion_review_requested",
        {},
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
    });
  }

  private async transitionIfBudgetExhausted(
    discussionId: string
  ): Promise<boolean> {
    const target = await this.store.read((state) => {
      const discussion = discussionById(state, discussionId);
      if (discussion.status !== "running") return null;
      const round = discussion.rounds.at(-1);
      if (!round?.runId || round.phase === "synthesis") return null;
      const run = state.runs.find((item) => item.id === round.runId);
      if (
        !run ||
        run.errorCode !== "discussion_budget_exhausted" ||
        run.status === "queued" ||
        run.status === "running" ||
        run.status === "waiting_approval"
      ) {
        return null;
      }
      return {
        round: structuredClone(round),
        budget: evaluateDiscussionBudget(state, discussion)
      };
    });
    if (!target) return false;
    await this.transitionBudgetExhausted(
      discussionId,
      target.round,
      target.budget,
      false
    );
    return true;
  }

  private async transitionBudgetExhausted(
    discussionId: string,
    round: DiscussionRound,
    evaluation: DiscussionBudgetEvaluation,
    emitEvent = true
  ): Promise<void> {
    const dimension = budgetDimension(evaluation);
    const decision =
      evaluation.decision === "hard_stop" ? "hard" : "soft";
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (!emitEvent) return;
      appendDiscussionEvent(
        discussion,
        "discussion_budget_exhausted",
        budgetExhaustedPayload({
          roundId: round.id,
          runId: round.runId,
          dimension,
          decision,
          evaluation
        }),
        this.eventFactory
      );
      discussion.updatedAt = this.clock();
      state.workspace.updatedAt = discussion.updatedAt;
    });
    const hasBrief = await this.store.read((state) =>
      Boolean(
        discussionById(state, discussionId).latestBriefArtifactId
      )
    );
    if (hasBrief) {
      await this.moveToReview(discussionId);
      return;
    }
    await this.prepareSynthesis(discussionId, round, {
      recordExhaustion: false
    });
  }

  private async prepareSynthesis(
    discussionId: string,
    sourceRound: DiscussionRound,
    options: { recordExhaustion?: boolean } = {}
  ): Promise<void> {
    const discussion = await this.getDiscussion(discussionId);
    const gate = await this.store.read((state) => {
      const current = discussionById(state, discussionId);
      const facilitator = current.participants.find(
        (participant) =>
          participant.id === current.facilitatorParticipantId
      );
      return {
        facilitatorAvailable: state.employees.some(
          (employee) =>
            employee.id === facilitator?.employeeId && employee.active
        ),
        pendingInterventions: pendingInterventionCount(state, discussionId)
      };
    });
    if (!gate.facilitatorAvailable) {
      await this.interruptDiscussion(
        discussionId,
        "discussion_facilitator_unavailable",
        sourceRound
      );
      return;
    }
    const availability = contentAvailability(discussion.rounds);
    if (
      availability.validPositionParticipants < 2 ||
      availability.validCrossResponseTurns < 1
    ) {
      await this.interruptDiscussion(
        discussionId,
        "discussion_insufficient_turns",
        sourceRound
      );
      return;
    }
    // Counted Turns are payload-validated at ingestion; re-check the
    // evidence invariant explicitly so restored or legacy records can
    // never reach Synthesis on unvalidated fact claims.
    const evidenceValid = discussion.rounds
      .flatMap((round) => round.turns)
      .filter((turn) => turn.status === "completed" && turn.payload)
      .every((turn) =>
        (turn.payload?.claims ?? []).every(
          (claim) =>
            claim.kind !== "fact" ||
            (claim.evidenceIds?.length ?? 0) > 0
        )
      );
    if (!evidenceValid) {
      await this.interruptDiscussion(
        discussionId,
        "discussion_evidence_unvalidated",
        sourceRound
      );
      return;
    }
    // The budget transition caller already recorded the exhaustion fact;
    // only gate and schedule in that case.
    if (options.recordExhaustion === false) {
      await this.preparePhase(
        discussionId,
        nextDiscussionRoundNumber(discussion.rounds),
        "synthesis"
      );
      return;
    }
    // Round, token, and cost limits take precedence over convergence
    // and over any model recommendation.
    if (contentRounds(discussion.rounds).length >= discussion.maxRounds) {
      await this.recordBudgetExhausted(discussionId, sourceRound);
      return;
    }
    if (
      hasDiscussionConverged(discussion.rounds, {
        pendingInterventions: gate.pendingInterventions
      })
    ) {
      await this.recordConvergence(discussionId, sourceRound);
      return;
    }
    await this.preparePhase(
      discussionId,
      nextDiscussionRoundNumber(discussion.rounds),
      "synthesis"
    );
  }

  private async recordConvergence(
    discussionId: string,
    round: DiscussionRound
  ): Promise<void> {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      appendDiscussionEvent(
        discussion,
        "discussion_converged",
        {
          roundId: round.id,
          runId: round.runId,
          reason: "consecutive_quiet_cross_response_rounds",
          requiredQuietRounds: CONVERGENCE_REQUIRED_QUIET_ROUNDS,
          ...advisoryConvergenceSummary(discussion)
        },
        this.eventFactory
      );
    });
    await this.preparePhase(
      discussionId,
      nextDiscussionRoundNumber(
        (
          await this.getDiscussion(discussionId)
        ).rounds
      ),
      "synthesis"
    );
  }

  private async recordBudgetExhausted(
    discussionId: string,
    round: DiscussionRound
  ): Promise<void> {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      appendDiscussionEvent(
        discussion,
        "discussion_budget_exhausted",
        {
          roundId: round.id,
          runId: round.runId,
          usedRounds: contentRounds(discussion.rounds).length,
          usedParticipants:
            round.activeParticipantIds?.length ??
            discussion.participants.length,
          maxRounds: discussion.maxRounds
        },
        this.eventFactory
      );
    });
    await this.preparePhase(
      discussionId,
      nextDiscussionRoundNumber(
        (
          await this.getDiscussion(discussionId)
        ).rounds
      ),
      "synthesis"
    );
  }

  private async interruptDiscussion(
    discussionId: string,
    code: string,
    round?: DiscussionRound
  ): Promise<void> {
    await this.store.update((state) => {
      const discussion = discussionById(state, discussionId);
      if (
        discussion.status === "completed" ||
        discussion.status === "cancelled"
      ) {
        return;
      }
      const timestamp = this.clock();
      discussion.status = "interrupted";
      discussion.updatedAt = timestamp;
      if (round) {
        const current = discussion.rounds.find(
          (item) => item.id === round.id
        );
        if (current && current.status !== "completed") {
          current.status = "interrupted";
        }
      }
      appendDiscussionEvent(
        discussion,
        "discussion_interrupted",
        {
          code,
          roundId: round?.id,
          runId: round?.runId
        },
        this.eventFactory
      );
      state.workspace.updatedAt = timestamp;
    });
  }

  private async startPreparedPhase(
    discussionId: string,
    options: { retry?: boolean; expectedRoundId?: string } = {}
  ): Promise<StartPhaseRunResult | null> {
    const prepared = await this.store.read((state) => {
      const discussion = discussionById(state, discussionId);
      const round = discussion.rounds.find(
        (item) =>
          item.status === "pending" &&
          (!options.expectedRoundId || item.id === options.expectedRoundId)
      );
      return round
        ? {
            discussion: structuredClone(discussion),
            round: structuredClone(round),
            context: phaseContext(state, discussion, round)
          }
        : null;
    });
    if (!prepared) return null;

    let started: StartPhaseRunResult;
    try {
      started = await this.runs.startPhaseRun(
        prepared.discussion.conversationId,
        {
          discussionId: prepared.discussion.id,
          roundId: prepared.round.id,
          participantSnapshot: prepared.discussion.participants,
          context: prepared.context,
          purpose: phasePurpose(prepared.round)
        },
        {
          retry: options.retry,
          preserveSnapshot: options.retry,
          onPhaseStarted: (_state, discussion, round, run) => {
            appendDiscussionEvent(
              discussion,
              "phase_started",
              {
                roundId: round.id,
                roundNumber: round.roundNumber,
                phase: round.phase,
                runId: run.id
              },
              this.eventFactory
            );
          }
        }
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "phase_run_exists"
      ) {
        return null;
      }
      throw error;
    }

    return started;
  }
}
