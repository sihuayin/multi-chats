import type { AppState, Run } from "@/server/domain/types";
import { isActiveRun } from "@/server/application/run-ledger";

export type RunResumeBlocker =
  | "active_run"
  | "visible_output"
  | "tool_side_effect"
  | "ambiguous_execution";

export const runResumeBlockerDetails: Record<
  RunResumeBlocker,
  { message: string; code: string }
> = {
  active_run: {
    message: "This Conversation already has an active Run",
    code: "active_run"
  },
  visible_output: {
    message: "Run cannot be resumed after visible output was produced",
    code: "run_resume_visible_output"
  },
  tool_side_effect: {
    message: "Run cannot be resumed after a Tool call has started",
    code: "run_resume_tool_side_effect"
  },
  ambiguous_execution: {
    message: "Run cannot be resumed after an ambiguous Provider execution",
    code: "run_resume_ambiguous_execution"
  }
};

export function runResumeBlocker(
  state: AppState,
  run: Run
): RunResumeBlocker | null {
  const activeRun = state.runs.some(
    (item) =>
      item.id !== run.id &&
      item.conversationId === run.conversationId &&
      isActiveRun(item)
  );
  if (activeRun) return "active_run";

  const completedMessageIds = new Set(
    state.runEvents
      .filter(
        (event) =>
          event.runId === run.id && event.type === "message_completed"
      )
      .map((event) => String(event.payload.messageId ?? ""))
  );
  const visibleUnfinishedMessage = state.messages.some(
    (message) =>
      message.runId === run.id &&
      message.authorType !== "user" &&
      !(
        message.authorType === "system" &&
        message.id === run.triggerMessageId &&
        message.taskId === run.taskId
      ) &&
      message.content.trim().length > 0 &&
      !completedMessageIds.has(message.id)
  );
  if (visibleUnfinishedMessage) return "visible_output";

  const unsafeToolStart = state.runEvents.some(
    (event) =>
      event.runId === run.id &&
      event.type === "tool_started" &&
      !completedMessageIds.has(String(event.payload.messageId ?? ""))
  );
  if (unsafeToolStart) return "tool_side_effect";

  const ambiguousAttempt = state.providerAttempts.some(
    (attempt) =>
      attempt.runId === run.id && attempt.status === "ambiguous"
  );
  if (ambiguousAttempt) return "ambiguous_execution";

  return null;
}
