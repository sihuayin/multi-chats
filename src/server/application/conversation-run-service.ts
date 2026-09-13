import type {
  AppState,
  Approval,
  Discussion,
  DiscussionRound,
  DiscussionTurn,
  DiscussionTurnPayload,
  Employee,
  Message,
  Run,
  RunEvent,
  ToolDefinition
} from "@/server/domain/types";
import type {
  ModelEvent,
  ModelGateway,
  ModelTool
} from "@/server/application/model-gateway";
import { validateDiscussionParticipants } from "@/server/application/discussion-domain";
import { parseDiscussionBrief } from "@/server/application/discussion-brief";
import { composeDiscussionPrompt } from "@/server/application/discussion-prompts";
import { parseDiscussionTurnPayload } from "@/server/application/discussion-turn-payload";
import { ApiError, notFound } from "@/server/application/errors";
import { appendEvent } from "@/server/application/run-ledger";
import {
  settleRun,
  type RunSettlementResult
} from "@/server/application/run-settlement";
import { transitionTask } from "@/server/application/task-ledger";
import {
  RegisteredToolGateway,
  type ToolExecutionResult,
  type ToolGateway
} from "@/server/application/tool-gateway";
import {
  messageInputSchema,
  phaseRunInputSchema
} from "@/server/domain/schemas";
import type { CredentialCipher } from "@/server/security/credential-cipher";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import type { StateStore } from "@/server/store/store";
import { logger } from "@/server/observability/logger";

export type StartTurnResult = {
  message: Message;
  run: Run | null;
};

export type StartPhaseRunResult = {
  message: Message;
  run: Run;
};

type ToolCallContext = {
  runId: string;
  requestId?: string;
  messageId: string;
  employeeId: string;
  allowedToolNames: string[];
  tool: ToolDefinition;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
};

function now(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseMentions(
  content: string,
  employees: Employee[]
): { all: boolean; employeeIds: string[] } {
  const mentions = [...content.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((match) =>
    match[1].toLowerCase()
  );
  const bySlug = new Map(
    employees.map((employee) => [slugify(employee.name), employee.id])
  );
  const employeeIds = mentions
    .map((mention) => bySlug.get(mention))
    .filter((id): id is string => Boolean(id));

  return {
    all: mentions.includes("all"),
    employeeIds
  };
}

function transcriptFor(state: AppState, conversationId: string): string {
  return state.messages
    .filter(
      (message) =>
        message.conversationId === conversationId &&
        message.status === "complete"
    )
    .map((message) => {
      const author =
        message.authorType === "user"
          ? "User"
          : message.authorType === "system"
            ? "System"
            : state.employees.find((employee) => employee.id === message.authorId)?.name ??
              "Employee";
      return `${author}: ${message.content}`;
    })
    .join("\n\n");
}

function phaseTranscriptFor(state: AppState, runId: string): string {
  return state.messages
    .filter(
      (message) =>
        message.runId === runId && message.status === "complete"
    )
    .map((message) => {
      const author =
        message.authorType === "system"
          ? "System"
          : state.employees.find(
              (employee) => employee.id === message.authorId
            )?.name ?? "Employee";
      return `${author}: ${message.content}`;
    })
    .join("\n\n");
}

function createRun(
  state: AppState,
  input: {
    conversationId: string;
    triggerMessage: Message;
    requestId?: string;
    memberSnapshot: string[];
    discussionId?: string;
    discussionRound?: number;
    runStartedPayload?: Record<string, unknown>;
  }
): Run {
  const activeRun = state.runs.find(
    (run) =>
      run.conversationId === input.conversationId &&
      ["queued", "running", "waiting_approval"].includes(run.status)
  );
  if (activeRun) {
    throw new ApiError(
      409,
      "This Conversation already has an active Run",
      "active_run"
    );
  }

  const timestamp = now();
  const run: Run = {
    id: crypto.randomUUID(),
    workspaceId: state.workspace.id,
    conversationId: input.conversationId,
    triggerMessageId: input.triggerMessage.id,
    requestId: input.requestId,
    ...(input.discussionId
      ? {
          discussionId: input.discussionId,
          discussionRound: input.discussionRound
        }
      : {}),
    memberSnapshot: input.memberSnapshot,
    status: "queued",
    createdAt: timestamp
  };
  state.runs.push(run);
  input.triggerMessage.runId = run.id;
  appendEvent(state, run, "run_started", {
    triggerMessageId: input.triggerMessage.id,
    memberSnapshot: input.memberSnapshot,
    ...input.runStartedPayload
  });
  state.workspace.updatedAt = timestamp;
  return run;
}

function taskContext(state: AppState, conversationId: string, employeeId: string): string {
  const tasks = state.tasks.filter(
    (task) =>
      task.conversationId === conversationId &&
      task.status !== "completed" &&
      task.status !== "cancelled" &&
      (task.assigneeIds.length === 0 || task.assigneeIds.includes(employeeId))
  );
  if (tasks.length === 0) return "No active tasks.";
  return tasks
    .map(
      (task) =>
        `Task ${task.id} "${task.title}" [${task.status}]: ${task.goal}${
          task.assigneeIds.includes(employeeId) ? " (assigned to you)" : ""
        }`
    )
    .join("\n");
}

function toolDefinitionsForEmployee(
  state: AppState,
  employee: Employee
): ToolDefinition[] {
  const skillIds = new Set(employee.skillIds);
  const allowedTools = new Set(
    state.skills
      .filter((skill) => skillIds.has(skill.id))
      .flatMap((skill) => skill.toolNames)
  );
  return BUILT_IN_TOOLS.filter((tool) => allowedTools.has(tool.name));
}

function settleApproval(
  state: AppState,
  runId: string,
  approval: Approval
): void {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return;
  if (run.status !== "cancelled") {
    run.status = "running";
  }
  appendEvent(state, run, "approval_resolved", {
    ...approvalPayload(approval)
  });
  logger.info("approval.resolved", {
    requestId: run?.requestId,
    runId,
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    status: approval.status
  });
}

function approvalPayload(approval: Approval): Record<string, unknown> {
  return {
    approvalId: approval.id,
    status: approval.status,
    employeeId: approval.employeeId,
    toolCallId: approval.toolCallId,
    messageId: approval.messageId,
    taskId: approval.taskId
  };
}

function logRunSettlement(
  result: RunSettlementResult,
  requestId?: string,
  fields: Record<string, unknown> = {}
): void {
  if (!result.settled) return;
  const data = {
    requestId,
    runId: result.runId,
    outcome: result.outcome,
    affectedMessageIds: result.affectedMessageIds,
    affectedApprovalIds: result.affectedApprovalIds,
    ...fields
  };
  if (result.outcome === "failed") {
    logger.error("run.failed", data);
  } else if (result.outcome === "interrupted") {
    logger.warn("run.interrupted", data);
  } else {
    logger.info(`run.${result.outcome}`, data);
  }
}

function settleDiscussionTurns(
  state: AppState,
  runId: string,
  error?: string
): void {
  for (const message of state.messages) {
    if (message.runId !== runId || !message.discussionTurnId) continue;
    const discussion = state.discussions.find(
      (item) => item.id === message.discussionId
    );
    const turn = discussion?.rounds
      .flatMap((round) => round.turns)
      .find((item) => item.id === message.discussionTurnId);
    if (!turn) continue;

    if (message.status === "complete") {
      turn.status = "completed";
      turn.content = message.content;
      turn.completedAt = message.updatedAt;
    } else if (message.status === "failed") {
      turn.status = "failed";
      turn.content = message.content;
      turn.validationError = error;
      turn.completedAt = message.updatedAt;
    } else if (message.status === "cancelled") {
      turn.status = "cancelled";
      turn.completedAt = message.updatedAt;
    } else if (message.status === "interrupted") {
      turn.status = "interrupted";
      turn.completedAt = message.updatedAt;
    }
  }
}

export class ConversationRunService {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly toolGateway: ToolGateway;

  constructor(
    private readonly store: StateStore,
    private readonly cipher: CredentialCipher,
    private readonly gateway: ModelGateway,
    private readonly options: {
      approvalTimeoutMs?: number;
      toolGateway?: ToolGateway;
    } = {}
  ) {
    this.toolGateway =
      options.toolGateway ?? new RegisteredToolGateway(store);
  }

  async recoverInterruptedRuns(): Promise<void> {
    const settlements = await this.store.update((state) => {
      const activeRuns = state.runs.filter(
        (run) => run.status === "running" || run.status === "waiting_approval"
      );
      const results = activeRuns.map((run) => ({
        requestId: run.requestId,
        result: settleRun(state, {
          runId: run.id,
          outcome: "interrupted",
          reason: "worker_restart",
          error: "Worker restarted while the Run was active",
          interrupted: true
        })
      }));
      activeRuns.forEach((run) => settleDiscussionTurns(state, run.id));
      return results;
    });
    for (const settlement of settlements) {
      logRunSettlement(settlement.result, settlement.requestId, {
        message: "Worker restarted while the Run was active"
      });
    }
  }

  async startTurn(
    conversationId: string,
    input: unknown,
    options: { requestId?: string } = {}
  ): Promise<StartTurnResult> {
    const parsed = messageInputSchema.parse(input);
    const result = await this.store.update((state) => {
      const conversation = state.conversations.find(
        (item) => item.id === conversationId
      );
      if (!conversation) notFound("Conversation");

      const timestamp = now();
      const message: Message = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId,
        authorType: "user",
        authorId: "user",
        content: parsed.content,
        status: "complete",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.messages.push(message);

      const members = conversation.memberIds
        .map((id) => state.employees.find((employee) => employee.id === id))
        .filter((employee): employee is Employee => Boolean(employee?.active));
      const mentioned = parseMentions(parsed.content, members);
      const memberSnapshot = mentioned.all
        ? members.map((employee) => employee.id)
        : members
            .filter((employee) => mentioned.employeeIds.includes(employee.id))
            .map((employee) => employee.id);

      if (memberSnapshot.length === 0) {
        return { message, run: null };
      }

      const run = createRun(state, {
        conversationId,
        triggerMessage: message,
        requestId: options.requestId,
        memberSnapshot
      });
      return { message, run };
    });
    if (result.run) {
      logger.info("run.started", {
        requestId: result.run.requestId,
        runId: result.run.id,
        conversationId,
        memberIds: result.run.memberSnapshot
      });
    }
    return result;
  }

  async startPhaseRun(
    conversationId: string,
    input: unknown,
    options: {
      requestId?: string;
      retry?: boolean;
      preserveSnapshot?: boolean;
      onPhaseStarted?: (
        state: AppState,
        discussion: Discussion,
        round: DiscussionRound,
        run: Run
      ) => void;
    } = {}
  ): Promise<StartPhaseRunResult> {
    const parsed = phaseRunInputSchema.parse(input);
    const result = await this.store.update((state) => {
      const conversation = state.conversations.find(
        (item) => item.id === conversationId
      );
      if (!conversation) notFound("Conversation");
      const discussion = state.discussions.find(
        (item) => item.id === parsed.discussionId
      );
      if (!discussion) notFound("Discussion");
      if (discussion.conversationId !== conversationId) {
        throw new ApiError(
          400,
          "Discussion does not belong to this Conversation",
          "invalid_discussion"
        );
      }
      if (discussion.status === "completed" || discussion.status === "cancelled") {
        throw new ApiError(
          409,
          "Completed or cancelled Discussions cannot run another phase",
          "discussion_terminal"
        );
      }
      const round = discussion.rounds.find((item) => item.id === parsed.roundId);
      if (!round) notFound("Discussion Round");
      const existingRun = round.runId
        ? state.runs.find((item) => item.id === round.runId)
        : undefined;
      if (
        existingRun &&
        (!options.retry ||
          !["completed", "failed", "cancelled", "interrupted"].includes(
            existingRun.status
          ))
      ) {
        throw new ApiError(
          409,
          "This Discussion Round already has a Run",
          "phase_run_exists"
        );
      }
      if (round.status !== "pending") {
        throw new ApiError(
          409,
          "Only pending Discussion Rounds can start a Run",
          "round_not_pending"
        );
      }

      const participants = [...parsed.participantSnapshot].sort(
        (left, right) => left.order - right.order
      );
      try {
        validateDiscussionParticipants(participants);
      } catch {
        throw new ApiError(
          400,
          "Discussion phase Participants are invalid",
          "invalid_participants"
        );
      }
      if (
        participants.filter(
          (participant) => participant.role === "facilitator"
        ).length !== 1 ||
        participants.find(
          (participant) => participant.role === "facilitator"
        )?.id !== discussion.facilitatorParticipantId
      ) {
        throw new ApiError(
          400,
          "Discussion phase Facilitator is invalid",
          "invalid_participants"
        );
      }
      if (
        participants.length !== discussion.participants.length ||
        participants.some((participant) => {
          const current = discussion.participants.find(
            (item) => item.id === participant.id
          );
          return (
            !current ||
            current.employeeId !== participant.employeeId ||
            current.role !== participant.role ||
            current.order !== participant.order ||
            current.objective !== participant.objective
          );
        })
      ) {
        throw new ApiError(
          400,
          "Discussion phase Participants do not match the Discussion",
          "invalid_participants"
        );
      }

      const conversationEmployeeIds = new Set(
        conversation.memberIds.filter((employeeId) =>
          state.employees.some(
            (employee) => employee.id === employeeId && employee.active
          )
        )
      );
      if (
        participants.some(
          (participant) =>
            !conversationEmployeeIds.has(participant.employeeId)
        )
      ) {
        throw new ApiError(
          400,
          "Discussion phase Participants must be active Conversation Employees",
          "invalid_participants"
        );
      }

      const timestamp = now();
      const requestedActiveIds = new Set(
        round.activeParticipantIds ??
          participants.map((participant) => participant.id)
      );
      const activeParticipants = (
        round.phase === "synthesis"
          ? participants.filter(
              (participant) => participant.role === "facilitator"
            )
          : participants
      ).filter((participant) => requestedActiveIds.has(participant.id));
      if (activeParticipants.length === 0) {
        throw new ApiError(
          409,
          "Discussion phase has no active Participants",
          "discussion_invalid_participants"
        );
      }
      const attempt = options.retry
        ? Math.max(
            0,
            ...round.turns.map((turn) => turn.attempt ?? 1)
          ) + 1
        : 1;
      if (!options.preserveSnapshot) {
        round.participantSnapshot = structuredClone(participants);
      }
      const turns: DiscussionTurn[] = activeParticipants.map((participant) => ({
        id: crypto.randomUUID(),
        employeeId: participant.employeeId,
        role: participant.role,
        order: participant.order,
        attempt,
        status: "pending" as const,
        createdAt: timestamp
      }));
      round.turns = options.retry
        ? [...round.turns, ...turns]
        : turns;
      round.activeParticipantIds = activeParticipants.map(
        (participant) => participant.id
      );
      round.status = "running";
      round.startedAt ??= timestamp;
      discussion.status = "running";
      discussion.startedAt ??= timestamp;
      discussion.updatedAt = timestamp;

      const message: Message = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId,
        discussionId: discussion.id,
        authorType: "system",
        authorId: "system",
        content: [
          `Discussion: ${discussion.title}`,
          `Discussion ID: ${discussion.id}`,
          `Round: ${round.roundNumber}`,
          `Phase: ${round.phase}`,
          `Purpose: ${parsed.purpose}`,
          `Context:\n${parsed.context}`
        ].join("\n"),
        status: "complete",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.messages.push(message);

      const run = createRun(state, {
        conversationId,
        triggerMessage: message,
        requestId: options.requestId,
        memberSnapshot: activeParticipants.map(
          (participant) => participant.employeeId
        ),
        discussionId: discussion.id,
        discussionRound: round.roundNumber,
        runStartedPayload: {
          discussionId: discussion.id,
          roundId: round.id,
          discussionRound: round.roundNumber,
          phase: round.phase,
          purpose: parsed.purpose
        }
      });
      round.runId = run.id;
      options.onPhaseStarted?.(state, discussion, round, run);
      return { message, run };
    });
    logger.info("run.started", {
      requestId: result.run.requestId,
      runId: result.run.id,
      conversationId,
      discussionId: parsed.discussionId,
      roundId: parsed.roundId,
      memberIds: result.run.memberSnapshot
    });
    return result;
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return this.store.read((state) =>
      state.messages.filter((message) => message.conversationId === conversationId)
    );
  }

  async listRunEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    return this.store.read((state) =>
      state.runEvents
        .filter(
          (event) => event.runId === runId && event.sequence > afterSequence
        )
        .sort((left, right) => left.sequence - right.sequence)
    );
  }

  async getRunById(runId: string): Promise<Run | null> {
    return this.store.read(
      (state) => state.runs.find((item) => item.id === runId) ?? null
    );
  }

  async cancelRun(runId: string): Promise<Run> {
    const controller = this.activeControllers.get(runId);
    controller?.abort();
    const stopRequested = Boolean(controller);
    const cancelled = await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      const settlement = settleRun(state, {
        runId,
        outcome: "cancelled",
        reason: "run_cancelled",
        cooperative: true,
        stopRequested
      });
      settleDiscussionTurns(state, runId);
      return { run: structuredClone(run), settlement };
    });
    logRunSettlement(cancelled.settlement, cancelled.run.requestId, {
      cooperative: true,
      stopRequested
    });
    return cancelled.run;
  }

  async resumeRun(runId: string): Promise<Run> {
    return this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      if (run.status !== "interrupted") {
        throw new ApiError(
          409,
          "Only interrupted Runs can be resumed",
          "run_resume"
        );
      }
      for (const message of state.messages) {
        if (message.runId === runId && message.status === "streaming") {
          message.status = "cancelled";
          message.updatedAt = now();
        }
      }
      settleDiscussionTurns(state, runId);
      run.status = "queued";
      run.error = undefined;
      run.startedAt = undefined;
      run.completedAt = undefined;
      appendEvent(state, run, "run_started", { resumed: true });
      state.workspace.updatedAt = now();
      return run;
    });
  }

  async processNextQueuedRun(signal?: AbortSignal): Promise<boolean> {
    const run = await this.store.read(
      (state) => state.runs.find((item) => item.status === "queued") ?? null
    );
    if (!run) return false;
    await this.processRun(run.id, signal);
    return true;
  }

  async processRun(runId: string, signal?: AbortSignal): Promise<Run> {
    const controller = new AbortController();
    let cancellationPoll: ReturnType<typeof setInterval> | undefined;
    this.activeControllers.set(runId, controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const claimed = await this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        if (run.status !== "queued") return false;
        run.status = "running";
        run.startedAt = now();
        state.workspace.updatedAt = run.startedAt;
        return true;
      });
      const initial = await this.store.read((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        return structuredClone(run);
      });
      if (!claimed) return initial;
      logger.info("run.processing", {
        requestId: initial.requestId,
        runId
      });
      cancellationPoll = setInterval(() => {
        void this.store
          .read((state) => state.runs.find((item) => item.id === runId)?.status)
          .then((status) => {
            if (status === "cancelled") controller.abort();
          })
          .catch(() => undefined);
      }, 300);

      const completedEmployeeIds = await this.store.read(
        (state) =>
          new Set(
            state.runEvents
              .filter(
                (event) =>
                  event.runId === runId && event.type === "message_completed"
              )
              .map((event) => String(event.payload.employeeId ?? ""))
          )
      );

      for (const employeeId of initial.memberSnapshot) {
        if (completedEmployeeIds.has(employeeId)) continue;
        if (controller.signal.aborted) break;
        await this.processEmployeeTurn(
          runId,
          employeeId,
          initial.triggerMessageId,
          controller.signal
        );
      }

      const completion = await this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        if (controller.signal.aborted || run.status === "cancelled") {
          return { run: structuredClone(run), settlement: null };
        }
        const settlement = settleRun(state, {
          runId,
          outcome: "completed",
          reason: "run_completed"
        });
        settleDiscussionTurns(state, runId);
        return { run: structuredClone(run), settlement };
      });
      if (completion.settlement) {
        logRunSettlement(
          completion.settlement,
          completion.run.requestId
        );
      }
      return completion.run;
    } catch (error) {
      if (controller.signal.aborted) {
        const cancellation = await this.store.update((state) => {
          const run = state.runs.find((item) => item.id === runId);
          if (!run) notFound("Run");
          const settlement = settleRun(state, {
            runId,
            outcome: "cancelled",
            reason: "run_cancelled",
            cooperative: true,
            stopRequested: false
          });
          settleDiscussionTurns(state, runId);
          return { run: structuredClone(run), settlement };
        });
        logRunSettlement(
          cancellation.settlement,
          cancellation.run.requestId,
          {
            cooperative: true
          }
        );
        return cancellation.run;
      }
      const message = error instanceof Error ? error.message : String(error);
      const failure = await this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        const settlement = settleRun(state, {
          runId,
          outcome: "failed",
          reason: "model_error",
          error: message
        });
        settleDiscussionTurns(state, runId, message);
        return { run: structuredClone(run), settlement };
      });
      logRunSettlement(failure.settlement, failure.run.requestId, {
        message
      });
      return failure.run;
    } finally {
      if (cancellationPoll) clearInterval(cancellationPoll);
      signal?.removeEventListener("abort", abort);
      this.activeControllers.delete(runId);
    }
  }

  private async processEmployeeTurn(
    runId: string,
    employeeId: string,
    triggerMessageId: string,
    signal: AbortSignal
  ): Promise<void> {
    const context = await this.store.read((state) => {
      const run = state.runs.find((item) => item.id === runId);
      const employee = state.employees.find((item) => item.id === employeeId);
      const trigger = state.messages.find((item) => item.id === triggerMessageId);
      if (!run || !employee || !trigger) {
        throw new Error("Run context is incomplete");
      }
      const discussion = run.discussionId
        ? state.discussions.find((item) => item.id === run.discussionId)
        : undefined;
      const round =
        discussion && run.discussionRound !== undefined
          ? discussion.rounds.find(
              (item) => item.roundNumber === run.discussionRound
            )
          : undefined;
      const participant = round?.participantSnapshot.find(
        (item) => item.employeeId === employeeId
      );
      const turn = round?.turns.find(
        (item) =>
          item.employeeId === employeeId &&
          (item.attempt ?? 1) ===
            Math.max(
              ...round.turns
                .filter((candidate) => candidate.employeeId === employeeId)
                .map((candidate) => candidate.attempt ?? 1)
            )
      );
      if (run.discussionId && (!discussion || !round || !participant || !turn)) {
        throw new Error("Discussion phase context is incomplete");
      }
      const credential = state.providers.find(
        (provider) => provider.id === employee.providerCredentialId
      );
      if (!credential) throw new Error("Employee provider is missing");
      const skills = employee.skillIds
        .map((id) => state.skills.find((skill) => skill.id === id))
        .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
      return {
        run: structuredClone(run),
        employee: structuredClone(employee),
        provider: credential.provider,
        encryptedCredential: credential.encryptedCredential,
        trigger: structuredClone(trigger),
        transcript: transcriptFor(state, run.conversationId),
        phaseTranscript: phaseTranscriptFor(state, run.id),
        taskContext: taskContext(state, run.conversationId, employeeId),
        tools: toolDefinitionsForEmployee(state, employee),
        skills: structuredClone(skills),
        phaseContext:
          discussion && round && participant && turn
            ? {
                discussionId: discussion.id,
                title: discussion.title,
                mode: discussion.mode,
                phase: round.phase,
                role: participant.role,
                objective: participant.objective,
                turnId: turn.id,
                profile: composeDiscussionPrompt({
                  mode: discussion.mode,
                  role: participant.role,
                  phase: round.phase,
                  objective: participant.objective,
                  language: discussion.language
                })
              }
            : undefined
      };
    });

    const message = await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      const timestamp = now();
      const message: Message = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId: run.conversationId,
        ...(run.discussionId ? { discussionId: run.discussionId } : {}),
        ...(context.phaseContext
          ? { discussionTurnId: context.phaseContext.turnId }
          : {}),
        authorType: "employee",
        authorId: employeeId,
        content: "",
        runId,
        status: "streaming",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.messages.push(message);
      if (context.phaseContext) {
        const discussion = state.discussions.find(
          (item) => item.id === run.discussionId
        );
        const round = discussion?.rounds.find(
          (item) => item.roundNumber === run.discussionRound
        );
        const turn = round?.turns.find(
          (item) => item.id === context.phaseContext?.turnId
        );
        if (!turn) throw new Error("Discussion Turn is missing");
        turn.status = "streaming";
        turn.messageId = message.id;
        turn.startedAt = timestamp;
      }
      appendEvent(state, run, "employee_turn_started", {
        employeeId,
        messageId: message.id,
        ...(run.discussionId
          ? {
              discussionId: run.discussionId,
              discussionTurnId: context.phaseContext?.turnId
            }
          : {})
      });
      for (const skill of context.skills) {
        appendEvent(state, run, "skill_loaded", {
          employeeId,
          messageId: message.id,
          skillId: skill.id,
          skillName: skill.name
        });
      }
      return structuredClone(message);
    });

    const allowedToolNames = context.tools.map((tool) => tool.name);
    const modelTools: ModelTool[] = context.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      inputSchema: tool.inputSchema,
      replay: tool.replay,
      execute: (toolCallId, args, toolSignal) =>
        this.executeTool({
          runId,
          requestId: context.run.requestId,
          messageId: message.id,
          employeeId,
          allowedToolNames,
          tool,
          toolCallId,
          args,
          signal: toolSignal
        })
    }));

    const systemPrompt = [
      `You are ${context.employee.name}.`,
      context.employee.identity,
      ...context.skills.map(
        (skill) =>
          `Skill: ${skill.name}\n${skill.instructions}\nInputs: ${skill.inputs.join(", ")}\nOutputs: ${skill.outputs.join(", ")}`
      ),
      context.phaseContext
        ? context.phaseContext.profile.systemInstructions
        : "",
      "Respond in the active Conversation. Do not claim to have used a Tool unless its result appears in the run."
    ].join("\n\n");

    const prompt = [
      context.phaseContext
        ? `Discussion phase transcript:\n${context.phaseTranscript}`
        : `Conversation transcript:\n${context.transcript}`,
      context.phaseContext
        ? ""
        : `Active task context:\n${context.taskContext}`,
      context.phaseContext
        ? `Discussion phase brief:\n${context.trigger.content}`
        : `Current user request:\n${context.run.memberSnapshot.length > 1 ? "Respond as your assigned role and account for earlier responses in this Run." : ""}`,
      context.phaseContext?.profile.objectiveContext ?? "",
      context.phaseContext?.profile.responseInstructions ??
        "Return a concise, useful response."
    ]
      .filter(Boolean)
      .join("\n\n");

    let finalText = "";
    let completed = false;
    let validatedPayload: DiscussionTurnPayload | undefined;
    let attempt = 0;
    while (attempt < 2 && !completed) {
      attempt += 1;
      let producedOutput = false;
      let retryableError = false;
      try {
        for await (const event of this.gateway.run({
          provider: context.provider,
          credential: this.cipher.decrypt(context.encryptedCredential),
          modelId: context.employee.modelId,
          systemPrompt,
          prompt,
          tools: modelTools,
          signal
        })) {
          await this.recordModelEvent(runId, message.id, employeeId, event);
          if (event.type === "text_delta" || event.type === "tool_started") {
            producedOutput = true;
          }
          if (event.type === "text_delta") finalText += event.delta;
          if (event.type === "text_completed" && event.text) finalText = event.text;
          if (event.type === "error") {
            retryableError = event.kind === "retryable";
            throw new Error(event.message);
          }
        }
        if (signal.aborted) throw new Error("Run cancelled");
        if (context.phaseContext) {
          try {
            if (context.phaseContext.phase === "synthesis") {
              const brief = parseDiscussionBrief(finalText);
              if (
                brief.promptProfileVersion !==
                  context.phaseContext.profile.version ||
                brief.discussionId !== context.phaseContext.discussionId ||
                brief.mode !== context.phaseContext.mode
              ) {
                throw new Error(
                  "Discussion Brief does not match the Discussion"
                );
              }
            } else {
              validatedPayload = parseDiscussionTurnPayload(
                finalText,
                context.phaseContext.phase
              );
            }
          } catch (error) {
            if (attempt >= 2) throw error;
            await this.store.update((state) => {
              const current = state.messages.find(
                (item) => item.id === message.id
              );
              if (current) {
                current.content = "";
                current.updatedAt = now();
              }
            });
            finalText = "";
            continue;
          }
        }
        completed = true;
      } catch (error) {
        if (signal.aborted || !retryableError || attempt >= 2 || producedOutput) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!completed) {
      throw new Error("Employee Run did not complete after retry");
    }

    await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      const current = state.messages.find((item) => item.id === message.id);
      if (!run || !current) notFound("Run");
      current.content = finalText;
      current.status = "complete";
      current.updatedAt = now();
      if (current.discussionTurnId && validatedPayload) {
        const discussion = state.discussions.find(
          (item) => item.id === current.discussionId
        );
        const turn = discussion?.rounds
          .flatMap((round) => round.turns)
          .find((item) => item.id === current.discussionTurnId);
        if (!turn) throw new Error("Discussion Turn is missing");
        turn.payload = validatedPayload;
        turn.validationError = undefined;
      }
      settleDiscussionTurns(state, runId);
      appendEvent(state, run, "message_completed", {
        messageId: current.id,
        employeeId,
        ...(current.discussionId
          ? {
              discussionId: current.discussionId,
              discussionTurnId: current.discussionTurnId
            }
          : {})
      });
      appendEvent(state, run, "employee_turn_completed", {
        messageId: current.id,
        employeeId,
        ...(current.discussionId
          ? {
              discussionId: current.discussionId,
              discussionTurnId: current.discussionTurnId
            }
          : {})
      });
      state.workspace.updatedAt = current.updatedAt;
    });
  }

  private async recordModelEvent(
    runId: string,
    messageId: string,
    employeeId: string,
    event: ModelEvent
  ): Promise<void> {
    await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      const message = state.messages.find((item) => item.id === messageId);
      if (!run || !message) return;
      const attribution = { messageId, employeeId };

      if (event.type === "text_delta") {
        message.content += event.delta;
        message.updatedAt = now();
        appendEvent(state, run, "message_delta", {
          ...attribution,
          delta: event.delta
        });
      }
      if (event.type === "tool_started") {
        appendEvent(state, run, "tool_started", {
          ...attribution,
          ...event
        });
      }
      if (event.type === "tool_completed") {
        appendEvent(state, run, "tool_completed", {
          ...attribution,
          ...event
        });
        if (event.isError) {
          appendEvent(
            state,
            run,
            event.errorKind === "cancelled" ? "tool_cancelled" : "tool_error",
            {
              ...attribution,
              ...event
            }
          );
        }
      }
      if (event.type === "error") {
        appendEvent(state, run, "model_error", {
          ...attribution,
          message: event.message,
          kind: event.kind ?? "terminal"
        });
      }
    });
  }

  private async executeTool(
    context: ToolCallContext
  ): Promise<ToolExecutionResult> {
    const { runId, messageId, employeeId, allowedToolNames, tool, args } =
      context;
    if (tool.requiresApproval) {
      const approval = await this.requestApproval(context);
      if (approval.status === "rejected") {
        return {
          content: "The user rejected this Tool call.",
          details: { approvalId: approval.id },
          isError: true,
          errorKind: "unauthorized"
        };
      }
      if (approval.status === "cancelled" || approval.status === "expired") {
        return {
          content: `Tool approval ${approval.status}.`,
          details: { approvalId: approval.id },
          isError: true,
          errorKind: "cancelled"
        };
      }
    }

    logger.info("tool.started", {
      requestId: context.requestId,
      runId,
      messageId,
      employeeId,
      toolName: tool.name,
      toolCallId: context.toolCallId
    });
    try {
      const result = await this.toolGateway.execute({
        tool,
        args,
        context: {
          runId,
          messageId,
          employeeId,
          allowedToolNames
        },
        signal: context.signal
      });
      logger.info("tool.completed", {
        requestId: context.requestId,
        runId,
        messageId,
        employeeId,
        toolName: tool.name,
        toolCallId: context.toolCallId,
        isError: Boolean(result.isError),
        errorKind: result.errorKind
      });
      return result;
    } catch (error) {
      if (context.signal?.aborted) {
        return {
          content: "Tool call cancelled.",
          isError: true,
          errorKind: "cancelled"
        };
      }
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
        errorKind: "execution"
      };
    }
  }

  private async requestApproval(context: ToolCallContext) {
    const { runId, messageId, employeeId, tool, toolCallId, args } = context;
    const timeoutMs = this.options.approvalTimeoutMs ?? 5 * 60_000;
    const approval = await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      const explicitTaskId =
        typeof args.taskId === "string" ? args.taskId : undefined;
      const task =
        state.tasks.find((item) => item.id === explicitTaskId) ??
        state.tasks.find(
          (item) =>
            item.conversationId === run.conversationId &&
            item.status !== "completed" &&
            item.status !== "cancelled" &&
            item.assigneeIds.includes(employeeId)
        );
      const timestamp = now();
      const approval = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        runId,
        messageId,
        taskId: task?.id,
        employeeId,
        toolCallId,
        toolName: tool.name,
        args,
        status: "pending" as const,
        createdAt: timestamp,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString()
      };
      state.approvals.push(approval);
      if (task) {
        if (task.status === "draft" || task.status === "review") {
          transitionTask(task, "in_progress", employeeId);
        }
        if (task.status !== "blocked") {
          transitionTask(task, "blocked", employeeId);
        }
      }
      run.status = "waiting_approval";
      appendEvent(state, run, "approval_requested", {
        approvalId: approval.id,
        employeeId,
        toolCallId,
        messageId,
        taskId: task?.id,
        toolName: tool.name,
        args
      });
      logger.info("approval.requested", {
        requestId: context.requestId,
        runId,
        approvalId: approval.id,
        messageId,
        employeeId,
        toolName: tool.name,
        toolCallId
      });
      return structuredClone(approval);
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await this.store.read(
        (state) => state.approvals.find((item) => item.id === approval.id) ?? approval
      );
      if (current.status !== "pending") {
        if (
          current.toolCallId &&
          current.toolCallId !== approval.toolCallId
        ) {
          throw new Error("Approval does not match this Tool call");
        }
        await this.store.update((state) => {
          settleApproval(state, runId, current);
        });
        return current;
      }
    }

    return this.store.update((state) => {
      const current = state.approvals.find((item) => item.id === approval.id);
      if (!current) notFound("Approval");
      if (current.status !== "pending") {
        settleApproval(state, runId, current);
        return structuredClone(current);
      }
      current.status = "expired";
      current.resolvedAt = now();
      if (current.taskId) {
        const task = state.tasks.find((item) => item.id === current.taskId);
        if (task && task.status !== "completed" && task.status !== "cancelled") {
          transitionTask(task, "in_progress", "user");
        }
      }
      settleApproval(state, runId, current);
      return structuredClone(current);
    });
  }
}
