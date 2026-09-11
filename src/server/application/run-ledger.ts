import type { AppState, Run, RunEvent } from "@/server/domain/types";

export function appendEvent(
  state: AppState,
  run: Run,
  type: RunEvent["type"],
  payload: Record<string, unknown> = {}
): RunEvent {
  const event: RunEvent = {
    id: crypto.randomUUID(),
    workspaceId: state.workspace.id,
    runId: run.id,
    sequence:
      state.runEvents
        .filter((item) => item.runId === run.id)
        .reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1,
    type,
    payload,
    createdAt: new Date().toISOString()
  };
  state.runEvents.push(event);
  return event;
}
