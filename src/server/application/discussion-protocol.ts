import type {
  AppState,
  Discussion,
  DiscussionRound,
  DiscussionRoundPhase,
  DiscussionTurnPayload
} from "@/server/domain/types";

export const DEFAULT_DISCUSSION_CONTENT_ROUNDS = 3;
export const MAX_DISCUSSION_CONTENT_ROUNDS = 5;

export function phaseRoundId(
  discussionId: string,
  roundNumber: number,
  phase: DiscussionRoundPhase
): string {
  return `${discussionId}:round:${roundNumber}:${phase}`;
}

export function nextDiscussionRoundNumber(
  rounds: DiscussionRound[]
): number {
  return Math.max(0, ...rounds.map((round) => round.roundNumber)) + 1;
}

export function phasePurpose(round: DiscussionRound): string {
  if (round.phase === "positions") {
    return "Establish each Participant's initial position, evidence, assumptions, risks, and open questions.";
  }
  if (round.phase === "cross_response") {
    return "Respond to earlier Turns, identify agreements and disagreements, and correct or refine prior claims.";
  }
  return "Synthesize all valid Discussion Turns into a decision-ready Brief.";
}

export function phaseContext(
  state: AppState,
  discussion: Discussion,
  round: DiscussionRound
): string {
  const turns = discussion.rounds
    .filter((item) =>
      round.phase === "synthesis"
        ? true
        : item.roundNumber < round.roundNumber
    )
    .flatMap((item) =>
      item.turns
        .filter((turn) => turn.status === "completed")
        .sort(
          (left, right) =>
            (right.attempt ?? 1) - (left.attempt ?? 1)
        )
        .filter(
          (turn, index, values) =>
            values.findIndex(
              (candidate) => candidate.employeeId === turn.employeeId
            ) === index
        )
        .map(
          (turn) =>
            `${turn.role} (${turn.employeeId}): ${
              turn.payload ? JSON.stringify(turn.payload) : turn.content ?? ""
            }`
        )
    );
  const relatedTaskIds = new Set(
    [discussion.sourceTaskId, discussion.confirmedTaskId].filter(
      (id): id is string => Boolean(id)
    )
  );
  const relatedArtifacts = state.artifacts.filter(
    (artifact) =>
      (artifact.ownerType === "discussion" &&
        artifact.ownerId === discussion.id) ||
      (artifact.ownerType === "task" &&
        relatedTaskIds.has(artifact.ownerId))
  );
  const sections = [
    discussion.constraints?.length
      ? `Constraints:\n${discussion.constraints.join("\n")}`
      : "",
    discussion.questions?.length
      ? `Questions:\n${discussion.questions.join("\n")}`
      : "",
    discussion.note ? `Note:\n${discussion.note}` : "",
    turns.length > 0 ? `Prior Turns:\n${turns.join("\n\n")}` : "",
    ...state.tasks
      .filter((task) => relatedTaskIds.has(task.id))
      .map(
        (task) =>
          `Related Task ${task.id} "${task.title}" [${task.status}]: ${task.goal}`
      ),
    ...relatedArtifacts.map(
      (artifact) =>
        `Related Artifact ${artifact.id} "${artifact.name}":\n${artifact.content}`
    )
  ].filter(Boolean);
  return sections.length > 0
    ? sections.join("\n\n")
    : "This is the first Discussion phase.";
}

function caseFold(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ");
}

function normalizedValues(payload: DiscussionTurnPayload): Set<string> {
  return new Set(
    [
      ...payload.claims.map((claim) => claim.statement),
      ...payload.assumptions,
      ...payload.risks,
      ...payload.openQuestions,
      ...(payload.disagreements ?? [])
    ]
      .map(caseFold)
      .filter(Boolean)
  );
}

export function hasDiscussionConverged(
  rounds: DiscussionRound[]
): boolean {
  const known = new Set<string>();
  let sawNoNewInformation = false;
  for (const round of rounds.filter(
    (item) => item.phase === "cross_response"
  )) {
    const values = new Set<string>();
    for (const turn of round.turns) {
      if (turn.status !== "completed" || !turn.payload) continue;
      for (const value of normalizedValues(turn.payload)) {
        values.add(value);
      }
    }
    const newValues = [...values].filter((value) => !known.has(value));
    if (newValues.length === 0 && values.size > 0) {
      sawNoNewInformation = true;
    }
    for (const value of values) known.add(value);
  }
  return sawNoNewInformation;
}

export function contentRounds(
  rounds: DiscussionRound[]
): DiscussionRound[] {
  return rounds.filter((round) => round.phase !== "synthesis");
}

export function contentAvailability(rounds: DiscussionRound[]): {
  validPositionParticipants: number;
  validCrossResponseTurns: number;
} {
  const positions = rounds.filter((round) => round.phase === "positions");
  const crossResponses = rounds.filter(
    (round) => round.phase === "cross_response"
  );
  return {
    validPositionParticipants: new Set(
      positions.flatMap((round) =>
        round.turns
          .filter(
            (turn) =>
              turn.status === "completed" &&
              (turn.payload || turn.content)
          )
          .map((turn) => turn.employeeId)
      )
    ).size,
    validCrossResponseTurns: crossResponses.reduce(
      (count, round) =>
        count +
        round.turns.filter(
          (turn) =>
            turn.status === "completed" &&
            (turn.payload || turn.content)
        ).length,
      0
    )
  };
}

export function latestTurnByEmployee(
  round: DiscussionRound,
  employeeId: string
) {
  return round.turns
    .filter((turn) => turn.employeeId === employeeId)
    .sort((left, right) => (right.attempt ?? 1) - (left.attempt ?? 1))[0];
}
