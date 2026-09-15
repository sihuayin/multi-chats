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

/**
 * Convergence requires this many consecutive completed Cross-response
 * Rounds that add no new normalized tracked value.
 */
export const CONVERGENCE_REQUIRED_QUIET_ROUNDS = 2;

function convergenceValues(payload: DiscussionTurnPayload): string[] {
  return [
    ...payload.claims.flatMap((claim) =>
      (claim.evidenceIds?.length ?? 0) > 0
        ? [
            caseFold(claim.statement),
            ...(claim.evidenceIds ?? []).map(caseFold)
          ]
        : []
    ),
    ...(payload.corrections ?? []).map(caseFold),
    ...payload.openQuestions.map(caseFold)
  ].filter(Boolean);
}

/**
 * Deterministic convergence: the last CONVERGENCE_REQUIRED_QUIET_ROUNDS
 * consecutive completed Cross-response Rounds each added no new
 * normalized supported claim, evidence reference, correction, or
 * unresolved question. Model recommendations never influence this
 * result, and pending Discussion interventions block convergence until
 * they are applied.
 */
export function hasDiscussionConverged(
  rounds: DiscussionRound[],
  options: { pendingInterventions?: number } = {}
): boolean {
  if ((options.pendingInterventions ?? 0) > 0) return false;
  const seen = new Set<string>();
  let consecutiveQuiet = 0;
  for (const round of rounds) {
    if (round.status !== "completed") continue;
    const values = new Set<string>();
    let payloadTurns = 0;
    for (const turn of round.turns) {
      if (turn.status !== "completed" || !turn.payload) continue;
      payloadTurns += 1;
      for (const value of convergenceValues(turn.payload)) {
        values.add(value);
      }
    }
    const hasNewValue = [...values].some((value) => !seen.has(value));
    for (const value of values) seen.add(value);
    if (round.phase === "cross_response") {
      // A Round without any validated payload is quiet from failure,
      // not from agreement: it never advances the streak.
      const quiet = payloadTurns > 0 && !hasNewValue;
      consecutiveQuiet = quiet ? consecutiveQuiet + 1 : 0;
    }
  }
  return consecutiveQuiet >= CONVERGENCE_REQUIRED_QUIET_ROUNDS;
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
            (turn) => turn.status === "completed" && turn.payload
          )
          .map((turn) => turn.employeeId)
      )
    ).size,
    validCrossResponseTurns: crossResponses.reduce(
      (count, round) =>
        count +
        round.turns.filter(
          (turn) => turn.status === "completed" && turn.payload
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
