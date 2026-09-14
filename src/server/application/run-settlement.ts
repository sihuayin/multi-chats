import { ApiError } from "@/server/application/errors";
import {
  appendEvent,
  type RunEventFactory
} from "@/server/application/run-ledger";
import type { AppState, Approval } from "@/server/domain/types";

export type RunOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

type SettlementBase = {
  runId: string;
  eventFactory?: RunEventFactory;
};

export type RunSettlementCommand =
  | (SettlementBase & {
      outcome: "completed";
      reason: "run_completed";
    })
  | (SettlementBase & {
      outcome: "failed";
      reason: "model_error" | "context_budget_exceeded";
      error: string;
      errorCode?: string;
    })
  | (SettlementBase & {
      outcome: "cancelled";
      reason: "run_cancelled";
      cooperative: boolean;
      stopRequested: boolean;
    })
  | (SettlementBase & {
      outcome: "interrupted";
      reason: "worker_restart";
      error: string;
      interrupted: true;
    });

export type RunSettlementResult = {
  settled: boolean;
  runId: string;
  outcome: RunOutcome;
  affectedMessageIds: string[];
  affectedApprovalIds: string[];
  completedAt: string;
};

function approvalReason(outcome: RunOutcome): string {
  if (outcome === "failed") return "run_failed";
  if (outcome === "interrupted") return "worker_restart";
  return `run_${outcome}`;
}

function approvalPayload(approval: Approval, reason: string) {
  return {
    approvalId: approval.id,
    status: approval.status,
    employeeId: approval.employeeId,
    toolCallId: approval.toolCallId,
    messageId: approval.messageId,
    taskId: approval.taskId,
    reason
  };
}

export function settleRun(
  state: AppState,
  command: RunSettlementCommand
): RunSettlementResult {
  const run = state.runs.find((item) => item.id === command.runId);
  if (!run) throw new ApiError(404, "Run not found", "not_found");

  const at =
    command.eventFactory?.now?.() ?? new Date().toISOString();
  if (
    ["completed", "failed", "cancelled", "interrupted"].includes(run.status)
  ) {
    return {
      settled: false,
      runId: run.id,
      outcome: command.outcome,
      affectedMessageIds: [],
      affectedApprovalIds: [],
      completedAt: run.completedAt ?? at
    };
  }

  const streamingMessages = state.messages.filter(
    (message) =>
      message.runId === run.id && message.status === "streaming"
  );
  if (command.outcome === "completed" && streamingMessages.length > 0) {
    throw new ApiError(
      409,
      "Completed Run cannot have streaming Messages",
      "run_settlement"
    );
  }

  const eventFactory: RunEventFactory = {
    id: command.eventFactory?.id,
    now: () => at
  };
  const affectedApprovalIds: string[] = [];
  for (const approval of state.approvals) {
    if (approval.runId !== run.id || approval.status !== "pending") continue;
    approval.status = "cancelled";
    approval.resolvedAt = at;
    affectedApprovalIds.push(approval.id);
    appendEvent(
      state,
      run,
      "approval_resolved",
      approvalPayload(approval, approvalReason(command.outcome)),
      eventFactory
    );
  }

  const affectedMessageIds: string[] = [];
  for (const message of streamingMessages) {
    affectedMessageIds.push(message.id);
    if (message.content) {
      appendEvent(
        state,
        run,
        "employee_turn_partial",
        {
          employeeId: message.authorId,
          messageId: message.id,
          reason: command.reason
        },
        eventFactory
      );
    }
    if (command.outcome === "failed") {
      message.status = "failed";
      appendEvent(
        state,
        run,
        "employee_turn_failed",
        {
          employeeId: message.authorId,
          messageId: message.id,
          message: command.error
        },
        eventFactory
      );
    } else if (command.outcome === "cancelled") {
      message.status = "cancelled";
      appendEvent(
        state,
        run,
        "employee_turn_cancelled",
        {
          employeeId: message.authorId,
          messageId: message.id,
          cooperative: command.cooperative,
          stopRequested: command.stopRequested
        },
        eventFactory
      );
    } else if (command.outcome === "interrupted") {
      message.status = "interrupted";
      appendEvent(
        state,
        run,
        "employee_turn_interrupted",
        {
          employeeId: message.authorId,
          messageId: message.id,
          reason: command.reason
        },
        eventFactory
      );
    }
    message.updatedAt = at;
  }

  run.status = command.outcome;
  run.completedAt = at;
  run.error = command.outcome === "failed" || command.outcome === "interrupted"
    ? command.error
    : undefined;
  const errorCode = "errorCode" in command ? command.errorCode : undefined;
  run.errorCode = errorCode;

  if (command.outcome === "completed") {
    appendEvent(
      state,
      run,
      "run_completed",
      { reason: command.reason },
      eventFactory
    );
  } else if (command.outcome === "cancelled") {
    appendEvent(
      state,
      run,
      "run_cancelled",
      {
        reason: command.reason,
        cooperative: command.cooperative,
        stopRequested: command.stopRequested
      },
      eventFactory
    );
  } else {
    appendEvent(
      state,
      run,
      "run_error",
      {
        reason: command.reason,
        message: command.error,
        errorCode,
        interrupted: command.outcome === "interrupted"
      },
      eventFactory
    );
  }

  state.workspace.updatedAt = at;
  return {
    settled: true,
    runId: run.id,
    outcome: command.outcome,
    affectedMessageIds,
    affectedApprovalIds,
    completedAt: at
  };
}
