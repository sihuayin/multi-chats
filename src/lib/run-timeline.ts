import type { RunEvent } from "@/server/domain/types";

export type RunTimelineCategory =
  | "model"
  | "skill"
  | "tool"
  | "approval"
  | "task"
  | "artifact"
  | "partial"
  | "error"
  | "status";

export type RunTimelineMessageEntry = {
  kind: "message";
  order: number;
  fromSequence: number;
  toSequence: number;
  messageId: string;
  employeeId?: string;
  content: string;
  createdAt: string;
};

export type RunTimelineEventEntry = {
  kind: "event";
  order: number;
  category: RunTimelineCategory;
  event: RunEvent;
};

export type RunTimelineEntry =
  | RunTimelineMessageEntry
  | RunTimelineEventEntry;

export type RunEventAssociation = {
  type: "message" | "task";
  id: string;
};

type RunEventMetadata = {
  artifactId?: string;
  error?: string;
  messageId?: string;
  skillName?: string;
  status?: string;
  taskId?: string;
  toolName?: string;
  triggerMessageId?: string;
};

function payloadString(event: RunEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value ? value : undefined;
}

function eventMetadata(event: RunEvent): RunEventMetadata {
  return {
    artifactId: payloadString(event, "artifactId"),
    error: payloadString(event, "message"),
    messageId: payloadString(event, "messageId"),
    skillName: payloadString(event, "skillName"),
    status: payloadString(event, "status"),
    taskId: payloadString(event, "taskId"),
    toolName: payloadString(event, "toolName"),
    triggerMessageId: payloadString(event, "triggerMessageId")
  };
}

export function eventCategory(type: string): RunTimelineCategory {
  if (type === "message_delta") return "model";
  if (type === "skill_loaded") return "skill";
  if (type.startsWith("tool_")) return "tool";
  if (type.startsWith("approval_")) return "approval";
  if (type === "task_changed") return "task";
  if (type === "artifact_created") return "artifact";
  if (type === "employee_turn_partial") return "partial";
  if (type.includes("error") || type.includes("failed")) return "error";
  return "status";
}

export function eventAssociations(event: RunEvent): RunEventAssociation[] {
  const metadata = eventMetadata(event);
  const associations: RunEventAssociation[] = [];
  const associatedMessageId = metadata.messageId ?? metadata.triggerMessageId;
  if (associatedMessageId) {
    associations.push({ type: "message", id: associatedMessageId });
  }
  if (metadata.taskId) {
    associations.push({ type: "task", id: metadata.taskId });
  }
  return associations;
}

export function eventSummary(event: RunEvent): string | undefined {
  const metadata = eventMetadata(event);
  const values = [
    metadata.skillName,
    metadata.toolName,
    metadata.status,
    metadata.artifactId,
    metadata.error
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : undefined;
}

export function buildRunTimeline(events: RunEvent[]): RunTimelineEntry[] {
  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence
  );
  const entries: RunTimelineEntry[] = [];

  for (const event of ordered) {
    if (event.type === "message_delta") {
      const messageId = payloadString(event, "messageId");
      const delta = payloadString(event, "delta") ?? "";
      const previous = entries.at(-1);
      if (
        messageId &&
        previous?.kind === "message" &&
        previous.messageId === messageId
      ) {
        previous.content += delta;
        previous.toSequence = event.sequence;
        continue;
      }
      entries.push({
        kind: "message",
        order: event.sequence,
        fromSequence: event.sequence,
        toSequence: event.sequence,
        messageId: messageId ?? "unknown-message",
        employeeId: payloadString(event, "employeeId"),
        content: delta,
        createdAt: event.createdAt
      });
      continue;
    }

    entries.push({
      kind: "event",
      order: event.sequence,
      category: eventCategory(event.type),
      event
    });
  }

  return entries;
}
