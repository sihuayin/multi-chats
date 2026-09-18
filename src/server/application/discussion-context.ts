import { createHash } from "node:crypto";
import type { ModelMessage } from "@/server/application/model-gateway";
import {
  composeDiscussionPrompt,
  DISCUSSION_PROMPT_PROFILE_VERSION
} from "@/server/application/discussion-prompts";
import { phasePurpose } from "@/server/application/discussion-protocol";
import { availableEvidence } from "@/server/application/discussion-evidence";
import {
  attachedReadyChunks,
  discussionRetrievalQuery,
  rankChunks
} from "@/server/application/source-retrieval";
import {
  compressionMatches,
  compressionSource
} from "@/server/application/discussion-compression";
import type {
  AppState,
  Discussion,
  DiscussionCompression,
  DiscussionIntervention,
  DiscussionParticipant,
  DiscussionRound,
  DiscussionTurn,
  Employee,
  Skill,
  ToolDefinition
} from "@/server/domain/types";

export const DEFAULT_MODEL_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const MIN_SAFETY_MARGIN_TOKENS = 512;
export const TOKEN_SAFETY_MARGIN_RATIO = 0.1;
export const DISCUSSION_CONTEXT_BUDGET_ERROR_CODE =
  "discussion_context_budget_exceeded";

export type ModelContext = {
  contextWindow: number;
  maxOutputTokens?: number;
  available?: boolean;
  supportsStructuredOutput?: boolean;
};

export type DiscussionContextPlan = {
  systemPrompt: string;
  promptProfileVersion: string;
  messages: ModelMessage[];
  contextWindow: number;
  inputBudget: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
  schemaOverheadTokens: number;
  toolOverheadTokens: number;
  inputTokens: number;
  outputReserveTokens: number;
  countSource: "exact" | "estimated";
  contextHash: string;
  roundIds: string[];
  turnIds: string[];
  messageIds: string[];
  compressionIds: string[];
  omittedRoundIds: string[];
};

type HistoryItem = {
  message: ModelMessage;
  roundId: string;
  roundNumber: number;
  turnId: string;
  order: number;
  unresolved: boolean;
  messageId?: string;
};

export class DiscussionContextBudgetError extends Error {
  readonly code = DISCUSSION_CONTEXT_BUDGET_ERROR_CODE;

  constructor(
    readonly details: {
      contextWindow: number;
      inputBudget: number;
      requiredTokens: number;
      outputReserveTokens: number;
      safetyMarginTokens: number;
      toolOverheadTokens: number;
    }
  ) {
    super(
      `Discussion context requires ${details.requiredTokens} tokens but the budget is ${details.inputBudget}`
    );
    this.name = "DiscussionContextBudgetError";
  }
}

function defaultTokenCount(value: string): number {
  return Math.ceil(new TextEncoder().encode(value).length / 3);
}

function messageTokenCount(
  message: ModelMessage,
  count: (value: string) => number
): number {
  return count(message.content) + 8;
}

function historyFor(
  state: AppState,
  discussion: Discussion,
  currentTurnId: string,
  currentRound: DiscussionRound
): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const round of discussion.rounds) {
    // Initial Positions must be independent. Cross-response and synthesis
    // phases still receive the completed Turns used to advance the Discussion.
    if (
      round.id === currentRound.id &&
      currentRound.phase === "positions"
    ) {
      continue;
    }
    const turnsByEmployee = new Map<string, DiscussionTurn>();
    for (const turn of round.turns) {
      if (
        turn.id === currentTurnId ||
        turn.status !== "completed" ||
        (!turn.payload && !turn.content)
      ) {
        continue;
      }
      const current = turnsByEmployee.get(turn.employeeId);
      if (!current || (turn.attempt ?? 1) > (current.attempt ?? 1)) {
        turnsByEmployee.set(turn.employeeId, turn);
      }
    }
    const participants = new Map(
      round.participantSnapshot.map((participant) => [
        participant.employeeId,
        participant
      ])
    );
    for (const turn of [...turnsByEmployee.values()].sort(
      (left, right) => left.order - right.order
    )) {
      const participant = participants.get(turn.employeeId);
      if (!participant) continue;
      const evidenceIds = [
        ...new Set(
          turn.payload?.claims.flatMap((claim) => claim.evidenceIds ?? []) ?? []
        )
      ];
      const messageId =
        turn.messageId && state.messages.some((message) => message.id === turn.messageId)
          ? turn.messageId
          : undefined;
      items.push({
        message: {
          id: messageId,
          role: "assistant",
          content: turn.payload
            ? JSON.stringify(turn.payload)
            : turn.content ?? "",
          kind: "discussion_turn",
          authorId: turn.employeeId,
          employeeId: turn.employeeId,
          discussionId: discussion.id,
          roundId: round.id,
          turnId: turn.id,
          participantId: participant.id,
          phase: round.phase,
          evidenceIds
        },
        roundId: round.id,
        roundNumber: round.roundNumber,
        turnId: turn.id,
        order: turn.order,
        unresolved: Boolean(
          turn.payload &&
            (turn.payload.disagreements?.length ||
              turn.payload.openQuestions.length)
        ),
        messageId
      });
    }
  }
  return items.sort(
    (left, right) =>
      left.roundNumber - right.roundNumber ||
      left.order - right.order
  );
}

function relatedContextMessages(
  state: AppState,
  discussion: Discussion,
  participant: DiscussionParticipant
): ModelMessage[] {
  const taskIds = new Set(
    [discussion.sourceTaskId, discussion.confirmedTaskId].filter(
      (id): id is string => Boolean(id)
    )
  );
  const tasks = state.tasks
    .filter(
      (task) =>
        taskIds.has(task.id) &&
        (task.assigneeIds.length === 0 ||
          task.assigneeIds.includes(participant.employeeId))
    )
    .map(
      (task): ModelMessage => ({
        id: `task-context-${task.id}`,
        role: "user",
        content: `Related Task ${task.id} "${task.title}" [${task.status}]: ${task.goal}`,
        kind: "task_context",
        discussionId: discussion.id,
        taskId: task.id
      })
    );
  const artifacts = state.artifacts
    .filter(
      (artifact) =>
        (artifact.ownerType === "discussion" &&
          artifact.ownerId === discussion.id) ||
        (artifact.ownerType === "task" && taskIds.has(artifact.ownerId))
    )
    .map(
      (artifact): ModelMessage => ({
        id: `artifact-context-${artifact.id}`,
        role: "user",
        content: `Related Artifact ${artifact.id} "${artifact.name}":\n${artifact.content}`,
        kind: "artifact_context",
        discussionId: discussion.id,
        artifactId: artifact.id
      })
    );
  const chunks = rankChunks(
    attachedReadyChunks(state, discussion),
    discussionRetrievalQuery(discussion)
  ).map(
    (chunk): ModelMessage => {
      const source = state.sources.find(
        (item) => item.id === chunk.sourceId
      );
      return {
        id: `source-chunk-${chunk.id}`,
        role: "user",
        content: `Source chunk external:${chunk.id} (${source?.title ?? chunk.sourceId}):\n${chunk.content}`,
        kind: "source_context",
        discussionId: discussion.id,
        sourceId: chunk.sourceId,
        chunkId: chunk.id
      };
    }
  );
  return [...tasks, ...artifacts, ...chunks];
}

function appliedInterventionMessages(
  interventions: DiscussionIntervention[],
  discussion: Discussion,
  currentTurnId: string,
  round: DiscussionRound,
  participant: DiscussionParticipant
): ModelMessage[] {
  return interventions.map((intervention): ModelMessage => ({
      id: `intervention-${intervention.id}`,
      role: "user",
      content: `User ${intervention.kind}:\n${intervention.content}`,
      kind: "user_intervention",
      discussionId: discussion.id,
      roundId: intervention.appliedRoundId ?? round.id,
      turnId: currentTurnId,
      participantId: participant.id,
      phase: intervention.appliedPhase ?? round.phase,
      interventionId: intervention.id
    }));
}

function compressionMessage(
  compression: DiscussionCompression,
  discussion: Discussion,
  currentTurnId: string,
  round: DiscussionRound,
  participant: DiscussionParticipant
): ModelMessage {
  return {
    id: `compression-${compression.id}`,
    role: "user",
    content: [
      `Compressed history version ${compression.schemaVersion} (${compression.strategy})`,
      `Source span: ${compression.sourceSpanHash}`,
      compression.content,
      ...(compression.unresolvedQuestions.length
        ? [
            `Unresolved questions:\n${compression.unresolvedQuestions
              .map((question) => `- ${question}`)
              .join("\n")}`
          ]
        : []),
      ...(compression.minorityPositions.length
        ? [
            `Minority positions:\n${compression.minorityPositions
              .map((position) => `- ${position}`)
              .join("\n")}`
          ]
        : [])
    ].join("\n"),
    kind: "conversation",
    discussionId: discussion.id,
    roundId: round.id,
    turnId: currentTurnId,
    participantId: participant.id,
    phase: round.phase,
    evidenceIds: compression.evidenceIds
  };
}

function systemPromptFor(
  employee: Employee,
  skills: Skill[],
  profile: ReturnType<typeof composeDiscussionPrompt>
): string {
  return [
    `You are ${employee.name}.`,
    employee.identity,
    ...skills.map(
      (skill) =>
        `Skill: ${skill.name}\n${skill.instructions}\nInputs: ${skill.inputs.join(", ")}\nOutputs: ${skill.outputs.join(", ")}`
    ),
    profile.systemInstructions,
    "Respond in the active Discussion. Do not claim to have used a Tool unless its result appears in the run."
  ].join("\n\n");
}

function contextHash(
  systemPrompt: string,
  messages: ModelMessage[]
): string {
  return createHash("sha256")
    .update(JSON.stringify({ systemPrompt, messages }))
    .digest("hex");
}

export function planDiscussionContext(input: {
  state: AppState;
  discussion: Discussion;
  round: DiscussionRound;
  participant: DiscussionParticipant;
  currentTurn: DiscussionTurn;
  employee: Employee;
  skills: Skill[];
  tools: ToolDefinition[];
  triggerMessageId?: string;
  triggerContent?: string;
  contextWindow: number;
  maxOutputTokens?: number;
  tokenCounter?: (value: string) => number;
  compressionTarget?: {
    provider?: AppState["providers"][number]["provider"];
    modelId?: string;
  };
}): DiscussionContextPlan {
  const count = input.tokenCounter ?? defaultTokenCount;
  const countSource = input.tokenCounter ? "exact" : "estimated";
  const contextWindow = Math.max(1, Math.floor(input.contextWindow));
  const maxOutputTokens = Math.max(
    1,
    Math.min(
      input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      Math.min(
        DEFAULT_MAX_OUTPUT_TOKENS,
        Math.floor(contextWindow * 0.25)
      )
    )
  );
  const safetyMarginTokens = Math.max(
    MIN_SAFETY_MARGIN_TOKENS,
    Math.ceil(contextWindow * TOKEN_SAFETY_MARGIN_RATIO)
  );
  const toolOverheadTokens =
    input.tools.reduce(
      (total, tool) =>
        total +
        count(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          })
        ) +
        8,
      0
    );
  const inputBudget =
    contextWindow -
    maxOutputTokens -
    safetyMarginTokens -
    toolOverheadTokens;
  if (inputBudget <= 0) {
    throw new DiscussionContextBudgetError({
      contextWindow,
      inputBudget,
      requiredTokens: 0,
      outputReserveTokens: maxOutputTokens,
      safetyMarginTokens,
      toolOverheadTokens
    });
  }

  const profile = composeDiscussionPrompt({
    mode: input.discussion.mode,
    role: input.participant.role,
    phase: input.round.phase,
    objective: input.participant.objective,
    language: input.discussion.language
  });
  const systemPrompt = systemPromptFor(
    input.employee,
    input.skills,
    profile
  );
  const appliedInterventions = input.state.discussionInterventions
    .filter(
      (intervention) =>
        intervention.discussionId === input.discussion.id &&
        intervention.status === "applied"
    )
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
  const interventionMessages = appliedInterventionMessages(
    appliedInterventions,
    input.discussion,
    input.currentTurn.id,
    input.round,
    input.participant
  );
  const appliedContentByKind = new Map<
    DiscussionIntervention["kind"],
    Set<string>
  >();
  for (const intervention of appliedInterventions) {
    const values =
      appliedContentByKind.get(intervention.kind) ?? new Set<string>();
    values.add(intervention.content);
    appliedContentByKind.set(intervention.kind, values);
  }
  const legacyConstraints = input.discussion.constraints?.filter(
    (constraint) =>
      !appliedContentByKind.get("constraint")?.has(constraint)
  );
  const legacyQuestions = input.discussion.questions?.filter(
    (question) => !appliedContentByKind.get("question")?.has(question)
  );
  const baseMessage = (content: string): ModelMessage => ({
    id: `context-${input.round.id}-${input.currentTurn.id}`,
    role: "user",
    content,
    kind: "conversation",
    discussionId: input.discussion.id,
    roundId: input.round.id,
    turnId: input.currentTurn.id,
    participantId: input.participant.id,
    phase: input.round.phase
  });
  const evidence = availableEvidence(input.state, input.discussion);
  // Chunk aliases are listed with their chunk text (bounded to the input
  // budget) below, not in the fixed evidence message, so a large Source never
  // blows the fixed-token budget.
  const structuralEvidence = evidence.filter(
    (item) => item.kind !== "external_source"
  );
  const currentPositionTurnIds = new Set(
    input.round.phase === "positions"
      ? input.round.turns.map((turn) => turn.id)
      : []
  );
  const visibleEvidence =
    input.round.phase === "positions"
      ? structuralEvidence.filter((item) => {
          const separator = item.id.indexOf(":");
          const kind = separator > 0 ? item.id.slice(0, separator) : "";
          const sourceId =
            separator > 0 ? item.id.slice(separator + 1) : item.id;
          if (kind === "turn" && currentPositionTurnIds.has(sourceId)) {
            return false;
          }
          if (kind === "message") {
            const message = input.state.messages.find(
              (candidate) => candidate.id === sourceId
            );
            if (
              message?.id !== input.triggerMessageId &&
              (message?.runId === input.round.runId ||
                (message?.discussionTurnId &&
                  currentPositionTurnIds.has(message.discussionTurnId)))
            ) {
              return false;
            }
          }
          return true;
        })
      : structuralEvidence;
  const evidenceMessage: ModelMessage = {
    ...baseMessage(
      [
        "Available evidence IDs:",
        ...visibleEvidence.map(
          (item) => `- ${item.id}: ${item.label}`
        ),
        "Concrete external sources may be cited as external:<full HTTPS URL>. The literal placeholder external:<https URL> is not valid evidence.",
        "Attached Source chunks are listed with their text below as external:<chunkId>."
      ].join("\n")
    ),
    kind: "conversation"
  };
  const discussionBrief: ModelMessage = {
    ...baseMessage(
      [
        `Discussion: ${input.discussion.title}`,
        `Discussion ID: ${input.discussion.id}`,
        `Mode: ${input.discussion.mode}`,
        `Round: ${input.round.roundNumber}`,
        `Phase: ${input.round.phase}`,
        `Purpose: ${phasePurpose(input.round)}`,
        ...(legacyConstraints?.length
          ? [`Constraints:\n${legacyConstraints.join("\n")}`]
          : []),
        ...(legacyQuestions?.length
          ? [`Questions:\n${legacyQuestions.join("\n")}`]
          : []),
        ...(input.discussion.note &&
        !appliedContentByKind.get("focus")?.has(input.discussion.note)
          ? [`Note:\n${input.discussion.note}`]
          : [])
      ].join("\n")
    ),
    kind: "conversation"
  };
  const objectiveMessage: ModelMessage = {
    ...baseMessage(profile.objectiveContext),
    kind: "conversation"
  };
  const currentRequestMessage: ModelMessage = {
    ...baseMessage(
      `Current Turn request:\n${input.triggerContent ?? "Continue the Discussion phase."}`
    ),
    kind: "conversation"
  };
  const responseMessage: ModelMessage = {
    ...baseMessage(profile.responseInstructions),
    kind: "conversation"
  };
  const fixedMessages = [
    discussionBrief,
    objectiveMessage,
    ...interventionMessages,
    evidenceMessage,
    currentRequestMessage,
    responseMessage
  ];
  const fixedTokens =
    count(systemPrompt) +
    fixedMessages.reduce(
      (total, message) => total + messageTokenCount(message, count),
      0
    );
  if (fixedTokens > inputBudget) {
    throw new DiscussionContextBudgetError({
      contextWindow,
      inputBudget,
      requiredTokens: fixedTokens,
      outputReserveTokens: maxOutputTokens,
      safetyMarginTokens,
      toolOverheadTokens
    });
  }

  const history = historyFor(
    input.state,
    input.discussion,
    input.currentTurn.id,
    input.round
  );
  const latestRound = history.at(-1)?.roundNumber;
  const mandatoryHistory = history.filter(
    (item) =>
      item.roundNumber === latestRound || item.unresolved
  );
  const mandatoryHistoryTokens = mandatoryHistory.reduce(
    (total, item) => total + messageTokenCount(item.message, count),
    0
  );
  if (fixedTokens + mandatoryHistoryTokens > inputBudget) {
    throw new DiscussionContextBudgetError({
      contextWindow,
      inputBudget,
      requiredTokens: fixedTokens + mandatoryHistoryTokens,
      outputReserveTokens: maxOutputTokens,
      safetyMarginTokens,
      toolOverheadTokens
    });
  }

  const selectedMessages = mandatoryHistory.map((item) => ({
    roundNumber: item.roundNumber,
    order: item.order,
    message: item.message,
    roundIds: [item.roundId],
    turnIds: [item.turnId],
    messageIds: item.messageId ? [item.messageId] : [],
    compressionId: undefined as string | undefined
  }));
  let usedTokens = fixedTokens + mandatoryHistoryTokens;
  const mandatoryTurnIds = new Set(
    mandatoryHistory.map((item) => item.turnId)
  );
  const optionalByRound = new Map<number, HistoryItem[]>();
  for (const item of history) {
    if (mandatoryTurnIds.has(item.turnId)) continue;
    const values = optionalByRound.get(item.roundNumber) ?? [];
    values.push(item);
    optionalByRound.set(item.roundNumber, values);
  }
  const compressionIds: string[] = [];
  const omittedRoundIds: string[] = [];
  for (const roundNumber of [...optionalByRound.keys()].sort(
    (left, right) => right - left
  )) {
    const items = optionalByRound.get(roundNumber) ?? [];
    const roundId = items[0]?.roundId;
    const round = input.discussion.rounds.find(
      (item) => item.id === roundId
    );
    if (!round) continue;
    const rawTokens = items.reduce(
      (total, item) => total + messageTokenCount(item.message, count),
      0
    );
    if (usedTokens + rawTokens <= inputBudget) {
      for (const item of items) {
        selectedMessages.push({
          roundNumber: item.roundNumber,
          order: item.order,
          message: item.message,
          roundIds: [item.roundId],
          turnIds: [item.turnId],
          messageIds: item.messageId ? [item.messageId] : [],
          compressionId: undefined
        });
      }
      usedTokens += rawTokens;
      continue;
    }

    const source = compressionSource([round]);
    const compression = input.state.discussionCompressions.find(
      (item) =>
        item.discussionId === input.discussion.id &&
        compressionMatches(item, source, input.compressionTarget)
    );
    if (compression) {
      const message = compressionMessage(
        compression,
        input.discussion,
        input.currentTurn.id,
        input.round,
        input.participant
      );
      const nextTokens = messageTokenCount(message, count);
      if (usedTokens + nextTokens > inputBudget) {
        omittedRoundIds.push(round.id);
        continue;
      }
      selectedMessages.push({
        roundNumber,
        order: 0,
        message,
        roundIds: compression.sourceRoundIds,
        turnIds: compression.sourceTurnIds,
        messageIds: [],
        compressionId: compression.id
      });
      compressionIds.push(compression.id);
      usedTokens += nextTokens;
      continue;
    }

    omittedRoundIds.push(round.id);
  }
  selectedMessages.sort(
    (left, right) =>
      left.roundNumber - right.roundNumber || left.order - right.order
  );

  const selectedRelated: ModelMessage[] = [];
  for (const message of relatedContextMessages(
    input.state,
    input.discussion,
    input.participant
  )) {
    const nextTokens = messageTokenCount(message, count);
    if (usedTokens + nextTokens > inputBudget) continue;
    selectedRelated.push(message);
    usedTokens += nextTokens;
  }

  const messages = [
    discussionBrief,
    objectiveMessage,
    ...interventionMessages,
    evidenceMessage,
    currentRequestMessage,
    ...selectedMessages.map((item) => item.message),
    ...selectedRelated,
    responseMessage
  ];
  const roundIds = [
    ...new Set([
      input.round.id,
      ...selectedMessages.flatMap((item) => item.roundIds)
    ])
  ];
  const turnIds = [
    ...new Set([
      input.currentTurn.id,
      ...selectedMessages.flatMap((item) => item.turnIds)
    ])
  ];
  const messageIds = [
    ...new Set([
      ...(input.triggerMessageId ? [input.triggerMessageId] : []),
      ...selectedMessages.flatMap((item) => item.messageIds)
    ])
  ];

  return {
    systemPrompt,
    promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
    messages,
    contextWindow,
    inputBudget,
    maxOutputTokens,
    safetyMarginTokens,
    schemaOverheadTokens: count(responseMessage.content),
    toolOverheadTokens,
    inputTokens:
      count(systemPrompt) +
      messages.reduce(
        (total, message) => total + messageTokenCount(message, count),
        0
      ),
    outputReserveTokens: maxOutputTokens,
    countSource,
    contextHash: contextHash(systemPrompt, messages),
    roundIds,
    turnIds,
    messageIds,
    compressionIds,
    omittedRoundIds
  };
}
