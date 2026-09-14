import { createHash } from "node:crypto";
import type { ModelMessage } from "@/server/application/model-gateway";
import {
  composeDiscussionPrompt,
  DISCUSSION_PROMPT_PROFILE_VERSION
} from "@/server/application/discussion-prompts";
import { phasePurpose } from "@/server/application/discussion-protocol";
import type {
  AppState,
  Discussion,
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
};

export type DiscussionContextPlan = {
  systemPrompt: string;
  promptProfileVersion: string;
  messages: ModelMessage[];
  contextWindow: number;
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
  currentTurnId: string
): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const round of discussion.rounds) {
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
  return [...tasks, ...artifacts];
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
  const discussionBrief: ModelMessage = {
    ...baseMessage(
      [
        `Discussion: ${input.discussion.title}`,
        `Discussion ID: ${input.discussion.id}`,
        `Mode: ${input.discussion.mode}`,
        `Round: ${input.round.roundNumber}`,
        `Phase: ${input.round.phase}`,
        `Purpose: ${phasePurpose(input.round)}`,
        ...(input.discussion.constraints?.length
          ? [`Constraints:\n${input.discussion.constraints.join("\n")}`]
          : []),
        ...(input.discussion.questions?.length
          ? [`Questions:\n${input.discussion.questions.join("\n")}`]
          : []),
        ...(input.discussion.note ? [`Note:\n${input.discussion.note}`] : [])
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
    input.currentTurn.id
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

  const selectedHistory = [...mandatoryHistory];
  let usedTokens = fixedTokens + mandatoryHistoryTokens;
  const mandatoryIds = new Set(
    mandatoryHistory.map((item) => item.turnId)
  );
  for (const item of history
    .filter((candidate) => !mandatoryIds.has(candidate.turnId))
    .reverse()) {
    const nextTokens = messageTokenCount(item.message, count);
    if (usedTokens + nextTokens > inputBudget) continue;
    selectedHistory.push(item);
    usedTokens += nextTokens;
  }
  selectedHistory.sort(
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
    currentRequestMessage,
    ...selectedHistory.map((item) => item.message),
    ...selectedRelated,
    responseMessage
  ];
  const roundIds = [
    ...new Set([
      input.round.id,
      ...selectedHistory.map((item) => item.roundId)
    ])
  ];
  const turnIds = [
    ...new Set([
      input.currentTurn.id,
      ...selectedHistory.map((item) => item.turnId)
    ])
  ];
  const messageIds = [
    ...new Set([
      ...(input.triggerMessageId ? [input.triggerMessageId] : []),
      ...selectedHistory
        .map((item) => item.messageId)
        .filter((id): id is string => Boolean(id))
    ])
  ];

  return {
    systemPrompt,
    promptProfileVersion: DISCUSSION_PROMPT_PROFILE_VERSION,
    messages,
    contextWindow,
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
    messageIds
  };
}
