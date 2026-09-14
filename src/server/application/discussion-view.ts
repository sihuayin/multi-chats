import type {
  AppState,
  Discussion,
  DiscussionEvent,
  DiscussionIntervention,
  DiscussionRound,
  Run
} from "@/server/domain/types";
import { notFound } from "@/server/application/errors";
import { aggregateModelUsage } from "@/server/application/model-usage";

export type DiscussionAction =
  | "edit"
  | "start"
  | "stop"
  | "retry"
  | "skip"
  | "add_constraints"
  | "synthesize"
  | "extend"
  | "confirm"
  | "cancel";

function availableActions(
  discussion: Discussion,
  hasBrief: boolean
): DiscussionAction[] {
  if (discussion.status === "draft") {
    return ["edit", "start", "cancel"];
  }
  if (discussion.status === "running") {
    return ["stop", "cancel"];
  }
  if (discussion.status === "interrupted") {
    return [
      "retry",
      "skip",
      "add_constraints",
      "synthesize",
      "cancel"
    ];
  }
  if (discussion.status === "review") {
    return [
      ...(hasBrief ? (["confirm"] as const) : []),
      "add_constraints",
      "synthesize",
      ...(discussion.rounds.filter(
        (round) => round.phase !== "synthesis"
      ).length < 5
        ? (["extend"] as const)
        : []),
      "cancel"
    ];
  }
  return [];
}

function roundView(round: DiscussionRound) {
  return {
    id: round.id,
    roundNumber: round.roundNumber,
    phase: round.phase,
    status: round.status,
    runId: round.runId,
    turnCount: round.turns.length,
    completedTurnCount: round.turns.filter(
      (turn) => turn.status === "completed"
    ).length,
    createdAt: round.createdAt,
    startedAt: round.startedAt,
    completedAt: round.completedAt
  };
}

function runView(run: Run) {
  return {
    id: run.id,
    status: run.status,
    discussionRound: run.discussionRound,
    memberSnapshot: run.memberSnapshot,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    errorCode: run.errorCode
  };
}

function taskView(task: AppState["tasks"][number]) {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    status: task.status,
    assigneeIds: task.assigneeIds,
    confirmedBriefArtifactId: task.confirmedBriefArtifactId
  };
}

function interventionView(intervention: DiscussionIntervention) {
  return {
    id: intervention.id,
    kind: intervention.kind,
    content: intervention.content,
    status: intervention.status,
    createdBy: intervention.createdBy,
    idempotencyKey: intervention.idempotencyKey,
    appliedPhase: intervention.appliedPhase,
    appliedRoundId: intervention.appliedRoundId,
    resultingDiscussionRevision:
      intervention.resultingDiscussionRevision,
    appliedAt: intervention.appliedAt,
    createdAt: intervention.createdAt,
    updatedAt: intervention.updatedAt
  };
}

function briefView(
  state: AppState,
  discussion: Discussion,
  artifactId: string | undefined
) {
  if (!artifactId) return undefined;
  const artifact = state.artifacts.find(
    (item) => item.id === artifactId
  );
  if (!artifact) return undefined;
  return {
    artifactId: artifact.id,
    revision: artifact.revision ?? 1,
    schemaVersion: artifact.schemaVersion ?? 1,
    name: artifact.name,
    content: artifact.content,
    createdAt: artifact.createdAt
  };
}

export function buildDiscussionView(
  state: AppState,
  discussionId: string
) {
  const discussion = state.discussions.find(
    (item) => item.id === discussionId
  );
  if (!discussion) notFound("Discussion");
  const latestRound = discussion.rounds.at(-1);
  const activeRun = latestRound?.runId
    ? state.runs.find(
        (run) =>
          run.id === latestRound.runId &&
          ["queued", "running", "waiting_approval"].includes(run.status)
      )
    : undefined;
  const latestBrief = briefView(
    state,
    discussion,
    discussion.latestBriefArtifactId
  );
  const confirmedBrief = briefView(
    state,
    discussion,
    discussion.confirmedBriefArtifactId
  );
  const sourceTask = discussion.sourceTaskId
    ? state.tasks.find((task) => task.id === discussion.sourceTaskId)
    : undefined;
  const confirmedTask = discussion.confirmedTaskId
    ? state.tasks.find((task) => task.id === discussion.confirmedTaskId)
    : undefined;
  const latestContextRevision = state.discussionContextRevisions
    .filter((revision) => revision.discussionId === discussion.id)
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    )
    .at(-1);
  const usage = aggregateModelUsage(
    state.providerAttempts.filter(
      (attempt) => attempt.discussionId === discussion.id
    )
  );
  const turns = discussion.rounds.flatMap((round) => round.turns);
  const factClaims = turns.flatMap(
    (turn) =>
      turn.payload?.claims.filter((claim) => claim.kind === "fact") ?? []
  );
  const evidence = {
    factCount: factClaims.length,
    factsWithEvidence: factClaims.filter(
      (claim) => (claim.evidenceIds?.length ?? 0) > 0
    ).length,
    validationFailureCount: (discussion.events ?? []).filter(
      (event) => event.type === "evidence_validation_failed"
    ).length
  };

  return {
    discussion: {
      id: discussion.id,
      conversationId: discussion.conversationId,
      title: discussion.title,
      mode: discussion.mode,
      language: discussion.language,
      status: discussion.status,
      facilitatorId:
        discussion.participants.find(
          (participant) =>
            participant.id === discussion.facilitatorParticipantId
        )?.employeeId ?? discussion.facilitatorParticipantId,
      participantCount: discussion.participants.length,
      currentRound: discussion.currentRound,
      maxRounds: discussion.maxRounds,
      latestBriefRevision: latestBrief?.revision,
      confirmedBriefArtifactId: discussion.confirmedBriefArtifactId,
      confirmedTaskId: discussion.confirmedTaskId,
      promptProfileVersion: discussion.promptProfileVersion,
      createdAt: discussion.createdAt,
      updatedAt: discussion.updatedAt
    },
    participants: discussion.participants
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((participant) => {
        const employee = state.employees.find(
          (item) => item.id === participant.employeeId
        );
        return {
          ...participant,
          name: employee?.name ?? participant.employeeId,
          active: Boolean(employee?.active)
        };
      }),
    rounds: discussion.rounds.map(roundView),
    interventions: state.discussionInterventions
      .filter(
        (intervention) => intervention.discussionId === discussion.id
      )
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      )
      .map(interventionView),
    latestBrief,
    confirmedBrief,
    sourceTask: sourceTask ? taskView(sourceTask) : undefined,
    confirmedTask: confirmedTask ? taskView(confirmedTask) : undefined,
    activeRun: activeRun ? runView(activeRun) : undefined,
    usage,
    evidence,
    budget: {
      usedRounds: discussion.rounds.filter(
        (round) => round.phase !== "synthesis"
      ).length,
      maxRounds: discussion.maxRounds,
      usedParticipants: discussion.participants.length,
      context: latestContextRevision
        ? {
            id: latestContextRevision.id,
            roundId: latestContextRevision.roundId,
            turnId: latestContextRevision.turnId,
            contextWindow: latestContextRevision.contextWindow,
            maxOutputTokens: latestContextRevision.maxOutputTokens,
            safetyMarginTokens: latestContextRevision.safetyMarginTokens,
            schemaOverheadTokens: latestContextRevision.schemaOverheadTokens,
            toolOverheadTokens: latestContextRevision.toolOverheadTokens,
            inputTokens: latestContextRevision.inputTokens,
            outputReserveTokens: latestContextRevision.outputReserveTokens,
            countSource: latestContextRevision.countSource,
            contextHash: latestContextRevision.contextHash,
            roundIds: latestContextRevision.roundIds,
            turnIds: latestContextRevision.turnIds,
            messageIds: latestContextRevision.messageIds,
            compressionIds: latestContextRevision.compressionIds,
            compressions: latestContextRevision.compressionIds
              .map((compressionId) =>
                state.discussionCompressions.find(
                  (compression) => compression.id === compressionId
                )
              )
              .filter(
                (
                  compression
                ): compression is NonNullable<typeof compression> =>
                  Boolean(compression)
              )
              .map((compression) => ({
                id: compression.id,
                schemaVersion: compression.schemaVersion,
                strategy: compression.strategy,
                sourceSpanHash: compression.sourceSpanHash
              })),
            createdAt: latestContextRevision.createdAt
          }
        : undefined
    },
    availableActions: availableActions(
      discussion,
      Boolean(latestBrief)
    )
  };
}

export function buildDiscussionRoundDetail(
  state: AppState,
  discussionId: string,
  roundId: string
) {
  const discussion = state.discussions.find(
    (item) => item.id === discussionId
  );
  if (!discussion) notFound("Discussion");
  const round = discussion.rounds.find((item) => item.id === roundId);
  if (!round) notFound("Discussion Round");
  const run = round.runId
    ? state.runs.find((item) => item.id === round.runId)
    : undefined;
  return {
    ...structuredClone(round),
    run: run ? runView(run) : undefined
  };
}

export function discussionEventView(
  event: DiscussionEvent,
  discussion: Discussion
) {
  return {
    eventId: event.id,
    discussionId: event.discussionId,
    sequence: event.sequence,
    type: event.type,
    occurredAt: event.createdAt,
    discussionStatus: discussion.status,
    ...event.payload
  };
}
