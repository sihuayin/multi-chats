import type { AppState, Run, RunEvent } from "@/server/domain/types";

const activeRunStatuses = new Set<Run["status"]>([
  "queued",
  "running",
  "waiting_approval"
]);

export function isActiveRun(run: Run): boolean {
  return activeRunStatuses.has(run.status);
}

export type RunEventFactory = {
  id?: () => string;
  now?: () => string;
};

export function appendEvent(
  state: AppState,
  run: Run,
  type: RunEvent["type"],
  payload: Record<string, unknown> = {},
  factory: RunEventFactory = {}
): RunEvent {
  const id = factory.id ?? (() => crypto.randomUUID());
  const now = factory.now ?? (() => new Date().toISOString());
  const event: RunEvent = {
    id: id(),
    workspaceId: state.workspace.id,
    runId: run.id,
    sequence:
      state.runEvents
        .filter((item) => item.runId === run.id)
        .reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1,
    type,
    payload,
    createdAt: now()
  };
  state.runEvents.push(event);
  return event;
}
