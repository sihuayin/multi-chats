import { describe, expect, it } from "vitest";
import {
  buildRunTimeline,
  eventAssociations,
  eventCategory,
  eventSummary
} from "@/lib/run-timeline";
import type { RunEvent } from "@/server/domain/types";

function event(
  sequence: number,
  type: RunEvent["type"],
  payload: Record<string, unknown> = {}
): RunEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace-1",
    runId: "run-1",
    sequence,
    type,
    payload,
    createdAt: `2026-01-01T00:00:0${sequence}.000Z`
  };
}

describe("Run timeline", () => {
  it("groups consecutive model deltas without changing event order", () => {
    const timeline = buildRunTimeline([
      event(1, "message_delta", { messageId: "message-1", delta: "Hello" }),
      event(2, "message_delta", { messageId: "message-1", delta: " world" }),
      event(3, "tool_started", {
        messageId: "message-1",
        toolCallId: "call-1",
        toolName: "current_time"
      }),
      event(4, "message_delta", { messageId: "message-1", delta: "!" })
    ]);

    expect(timeline.map((entry) => entry.order)).toEqual([1, 3, 4]);
    expect(timeline[0]).toMatchObject({
      kind: "message",
      messageId: "message-1",
      content: "Hello world",
      fromSequence: 1,
      toSequence: 2
    });
    expect(timeline[1]).toMatchObject({
      kind: "event",
      category: "tool",
      event: { type: "tool_started" }
    });
    expect(timeline[2]).toMatchObject({
      kind: "message",
      messageId: "message-1",
      content: "!"
    });
  });

  it("categorizes events and exposes Message and Task associations", () => {
    expect(eventCategory("skill_loaded")).toBe("skill");
    expect(eventCategory("tool_completed")).toBe("tool");
    expect(eventCategory("approval_requested")).toBe("approval");
    expect(eventCategory("task_changed")).toBe("task");
    expect(eventCategory("artifact_created")).toBe("artifact");
    expect(eventCategory("employee_turn_partial")).toBe("partial");
    expect(eventCategory("run_error")).toBe("error");
    expect(eventCategory("run_completed")).toBe("status");
    expect(
      eventSummary(event(1, "skill_loaded", { skillName: "Researcher" }))
    ).toBe("Researcher");
    expect(
      eventSummary(
        event(2, "provider_fallback_started", {
          provider: "anthropic",
          modelId: "fallback-model",
          reason: "provider_retryable"
        })
      )
    ).toBe("anthropic/fallback-model · provider_retryable");

    expect(
      eventAssociations(
        event(1, "approval_requested", {
          messageId: "message-1",
          taskId: "task-1"
        })
      )
    ).toEqual([
      { type: "message", id: "message-1" },
      { type: "task", id: "task-1" }
    ]);
  });

  it("sorts persisted events by Run sequence", () => {
    const timeline = buildRunTimeline([
      event(3, "run_completed"),
      event(1, "run_started"),
      event(2, "skill_loaded", { skillName: "Researcher" })
    ]);

    expect(timeline.map((entry) => entry.order)).toEqual([1, 2, 3]);
    expect(timeline.map((entry) =>
      entry.kind === "event" ? entry.event.type : entry.kind
    )).toEqual(["run_started", "skill_loaded", "run_completed"]);
  });
});
