import type {
  Artifact,
  Discussion,
  DiscussionMode,
  DiscussionParticipant,
  DiscussionRole,
  DiscussionRound,
  DiscussionRoundPhase,
  DiscussionRoundStatus,
  DiscussionStatus,
  DiscussionTurn,
  DiscussionTurnPayload,
  DiscussionTurnStatus,
  Message,
  Run
} from "@/server/domain/types";

const modes = new Set<DiscussionMode>([
  "requirements",
  "problem",
  "solution",
  "review"
]);
const roles = new Set<DiscussionRole>([
  "analyst",
  "researcher",
  "skeptic",
  "designer",
  "facilitator"
]);
const statuses = new Set<DiscussionStatus>([
  "draft",
  "running",
  "review",
  "interrupted",
  "completed",
  "cancelled"
]);
const roundPhases = new Set<DiscussionRoundPhase>([
  "positions",
  "cross_response",
  "synthesis"
]);
const roundStatuses = new Set<DiscussionRoundStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "interrupted",
  "cancelled"
]);
const turnStatuses = new Set<DiscussionTurnStatus>([
  "pending",
  "streaming",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);
const confidenceLevels = new Set(["low", "medium", "high"]);
const activeStatuses = new Set<DiscussionStatus>([
  "draft",
  "running",
  "review",
  "interrupted"
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

function validateParticipantList(
  participants: DiscussionParticipant[],
  snapshot = false
) {
  const prefix = snapshot ? "Discussion round participant snapshot" : "Discussion";
  if (participants.length < 2 || participants.length > 8) {
    throw new Error(`${prefix} requires 2 to 8 participants`);
  }
  if (
    new Set(participants.map((item) => item.id)).size !== participants.length
  ) {
    throw new Error(
      snapshot
        ? "Discussion round participant snapshot IDs must be unique"
        : "Discussion participant IDs must be unique"
    );
  }
  if (
    new Set(participants.map((item) => item.employeeId)).size !==
    participants.length
  ) {
    throw new Error(
      snapshot
        ? "Discussion round participant snapshot Employees must be unique"
        : "Discussion participants must be unique"
    );
  }
  if (
    new Set(participants.map((item) => item.order)).size !==
    participants.length
  ) {
    throw new Error(
      snapshot
        ? "Discussion round participant snapshot order must be unique"
        : "Discussion participant order must be unique"
    );
  }
  if (
    participants.some(
      (participant) =>
        !nonEmptyString(participant.id) ||
        !nonEmptyString(participant.employeeId) ||
        !roles.has(participant.role) ||
        !Number.isInteger(participant.order) ||
        participant.order < 1 ||
        !nonEmptyString(participant.objective)
    )
  ) {
    throw new Error(
      snapshot
        ? "Discussion round participant is invalid"
        : "Discussion participant is invalid"
    );
  }
}

function validateTurnPayload(payload: DiscussionTurnPayload): void {
  if (
    !nonEmptyString(payload.summary) ||
    !Array.isArray(payload.claims) ||
    payload.claims.some(
      (claim) =>
        !nonEmptyString(claim.statement) ||
        !confidenceLevels.has(claim.confidence) ||
        (claim.evidence !== undefined &&
          typeof claim.evidence !== "string")
    ) ||
    !stringArray(payload.assumptions) ||
    !stringArray(payload.risks) ||
    !stringArray(payload.openQuestions) ||
    (payload.agreements !== undefined &&
      !stringArray(payload.agreements)) ||
    (payload.disagreements !== undefined &&
      !stringArray(payload.disagreements)) ||
    (payload.corrections !== undefined &&
      !stringArray(payload.corrections))
  ) {
    throw new Error("Discussion turn payload is invalid");
  }
}

function validateTurn(
  turn: DiscussionTurn,
  participantSnapshot: DiscussionParticipant[],
  activeParticipantIds?: Set<string>
): void {
  if (
    !nonEmptyString(turn.id) ||
    !nonEmptyString(turn.employeeId) ||
    !roles.has(turn.role) ||
    !Number.isInteger(turn.order) ||
    turn.order < 1 ||
    !isoDate(turn.createdAt) ||
    (turn.startedAt !== undefined && !isoDate(turn.startedAt)) ||
    (turn.completedAt !== undefined && !isoDate(turn.completedAt)) ||
    (turn.messageId !== undefined && !nonEmptyString(turn.messageId)) ||
    (turn.content !== undefined && typeof turn.content !== "string") ||
    (turn.validationError !== undefined &&
      !nonEmptyString(turn.validationError))
  ) {
    throw new Error("Discussion turn is invalid");
  }
  if (!turnStatuses.has(turn.status)) {
    throw new Error("Discussion turn status is invalid");
  }
  const participant = participantSnapshot.find(
    (item) => item.employeeId === turn.employeeId
  );
  if (!participant) {
    throw new Error(
      "Discussion turn Employee is not in the round participant snapshot"
    );
  }
  if (activeParticipantIds && !activeParticipantIds.has(participant.id)) {
    throw new Error("Discussion turn participant is not active in the round");
  }
  if (participant.role !== turn.role || participant.order !== turn.order) {
    throw new Error(
      "Discussion turn role and order must match the participant snapshot"
    );
  }
  if (turn.payload !== undefined) {
    validateTurnPayload(turn.payload);
  }
}

function validateRound(round: DiscussionRound): void {
  if (
    !nonEmptyString(round.id) ||
    !Number.isInteger(round.roundNumber) ||
    round.roundNumber < 1 ||
    !isoDate(round.createdAt) ||
    (round.startedAt !== undefined && !isoDate(round.startedAt)) ||
    (round.completedAt !== undefined && !isoDate(round.completedAt)) ||
    (round.runId !== undefined && !nonEmptyString(round.runId))
  ) {
    throw new Error("Discussion round is invalid");
  }
  if (!roundPhases.has(round.phase)) {
    throw new Error("Discussion round phase is invalid");
  }
  if (!roundStatuses.has(round.status)) {
    throw new Error("Discussion round status is invalid");
  }
  if (!Array.isArray(round.participantSnapshot)) {
    throw new Error("Discussion round participant snapshot is invalid");
  }
  validateParticipantList(round.participantSnapshot, true);
  if (
    round.participantSnapshot.filter(
      (participant) => participant.role === "facilitator"
    ).length !== 1
  ) {
    throw new Error(
      "Discussion round participant snapshot requires exactly one Facilitator participant"
    );
  }

  const activeParticipantIds = round.activeParticipantIds;
  let activeIds: Set<string> | undefined;
  if (activeParticipantIds !== undefined) {
    const snapshotIds = new Set(
      round.participantSnapshot.map((participant) => participant.id)
    );
    if (
      !Array.isArray(activeParticipantIds) ||
      activeParticipantIds.length === 0 ||
      new Set(activeParticipantIds).size !== activeParticipantIds.length ||
      activeParticipantIds.some(
        (id) => !nonEmptyString(id) || !snapshotIds.has(id)
      )
    ) {
      throw new Error("Discussion round active participants are invalid");
    }
    activeIds = new Set(activeParticipantIds);
  }

  if (!Array.isArray(round.turns)) {
    throw new Error("Discussion round turns are invalid");
  }
  if (
    new Set(round.turns.map((turn) => turn.id)).size !==
    round.turns.length
  ) {
    throw new Error("Discussion turn IDs must be unique");
  }
  if (
    new Set(round.turns.map((turn) => turn.employeeId)).size !==
    round.turns.length
  ) {
    throw new Error("Discussion turn Employees must be unique");
  }
  if (
    new Set(round.turns.map((turn) => turn.order)).size !==
    round.turns.length
  ) {
    throw new Error("Discussion turn order must be unique");
  }
  round.turns.forEach((turn) =>
    validateTurn(turn, round.participantSnapshot, activeIds)
  );
}

export function validateDiscussion(discussion: Discussion): void {
  if (
    !nonEmptyString(discussion.id) ||
    !nonEmptyString(discussion.workspaceId) ||
    !nonEmptyString(discussion.conversationId) ||
    !nonEmptyString(discussion.title) ||
    !isoDate(discussion.createdAt) ||
    !isoDate(discussion.updatedAt) ||
    (discussion.startedAt !== undefined && !isoDate(discussion.startedAt)) ||
    (discussion.completedAt !== undefined && !isoDate(discussion.completedAt))
  ) {
    throw new Error("Discussion is invalid");
  }
  if (!modes.has(discussion.mode)) {
    throw new Error("Discussion mode is invalid");
  }
  if (discussion.language !== "en" && discussion.language !== "zh") {
    throw new Error("Discussion language is invalid");
  }
  if (!statuses.has(discussion.status)) {
    throw new Error("Discussion status is invalid");
  }
  if (!Array.isArray(discussion.participants)) {
    throw new Error("Discussion participants are invalid");
  }
  validateParticipantList(discussion.participants);

  const facilitators = discussion.participants.filter(
    (participant) => participant.role === "facilitator"
  );
  if (facilitators.length !== 1) {
    throw new Error("Discussion requires exactly one Facilitator participant");
  }
  if (facilitators[0].id !== discussion.facilitatorParticipantId) {
    throw new Error("Facilitator must be a Discussion participant");
  }
  if (
    [
      discussion.latestBriefArtifactId,
      discussion.confirmedBriefArtifactId,
      discussion.sourceTaskId,
      discussion.confirmedTaskId
    ].some((value) => value !== undefined && !nonEmptyString(value))
  ) {
    throw new Error("Discussion reference is invalid");
  }
  if (
    !Number.isInteger(discussion.maxRounds) ||
    discussion.maxRounds < 1 ||
    discussion.maxRounds > 5
  ) {
    throw new Error("Discussion maxRounds must be between 1 and 5");
  }
  if (
    !Number.isInteger(discussion.currentRound) ||
    discussion.currentRound < 0 ||
    discussion.currentRound > discussion.maxRounds
  ) {
    throw new Error("Discussion currentRound is invalid");
  }
  if (!Array.isArray(discussion.rounds)) {
    throw new Error("Discussion rounds are invalid");
  }
  if (
    new Set(discussion.rounds.map((round) => round.id)).size !==
    discussion.rounds.length
  ) {
    throw new Error("Discussion round IDs must be unique");
  }
  if (
    new Set(discussion.rounds.map((round) => round.roundNumber)).size !==
    discussion.rounds.length
  ) {
    throw new Error("Discussion round numbers must be unique");
  }
  discussion.rounds.forEach(validateRound);
}

export function validateDiscussionReferences(input: {
  discussions: Discussion[];
  artifacts: Artifact[];
  messages: Array<
    Pick<Message, "id" | "discussionId" | "discussionTurnId">
  >;
  runs: Array<Pick<Run, "id" | "discussionId" | "discussionRound">>;
}): void {
  const activeByConversation = new Map<string, string>();
  const turnIds = new Set<string>();
  const discussionIds = new Set<string>();
  const artifactsById = new Map(
    input.artifacts.map((artifact) => [artifact.id, artifact])
  );

  input.discussions.forEach((discussion) => {
    if (discussionIds.has(discussion.id)) {
      throw new Error("Discussion IDs must be unique");
    }
    discussionIds.add(discussion.id);
    discussion.rounds.forEach((round) => {
      round.turns.forEach((turn) => {
        if (turnIds.has(turn.id)) {
          throw new Error("Discussion turn IDs must be globally unique");
        }
        turnIds.add(turn.id);
      });
    });

    if (activeStatuses.has(discussion.status)) {
      const activeId = activeByConversation.get(discussion.conversationId);
      if (activeId) {
        throw new Error(
          "Conversation can have at most one active Discussion"
        );
      }
      activeByConversation.set(discussion.conversationId, discussion.id);
    }

    for (const reference of [
      discussion.latestBriefArtifactId,
      discussion.confirmedBriefArtifactId
    ]) {
      if (!reference) continue;
      const artifact = artifactsById.get(reference);
      if (
        !artifact ||
        artifact.ownerType !== "discussion" ||
        artifact.ownerId !== discussion.id
      ) {
        throw new Error("Discussion Brief reference is invalid");
      }
    }
  });

  input.messages.forEach((message) => {
    if (message.discussionId === undefined) {
      if (message.discussionTurnId !== undefined) {
        throw new Error(
          "Message discussionTurnId requires discussionId"
        );
      }
      return;
    }
    if (!discussionIds.has(message.discussionId)) {
      throw new Error("Message references an unknown Discussion");
    }
    if (
      message.discussionTurnId !== undefined &&
      !turnIds.has(message.discussionTurnId)
    ) {
      throw new Error("Message references an unknown Discussion Turn");
    }
  });

  input.runs.forEach((run) => {
    if (run.discussionId === undefined) {
      if (run.discussionRound !== undefined) {
        throw new Error("Run discussionRound requires discussionId");
      }
      return;
    }
    if (!discussionIds.has(run.discussionId)) {
      throw new Error("Run references an unknown Discussion");
    }
    if (
      run.discussionRound !== undefined &&
      (!Number.isInteger(run.discussionRound) || run.discussionRound < 1)
    ) {
      throw new Error("Run discussionRound is invalid");
    }
  });
}
