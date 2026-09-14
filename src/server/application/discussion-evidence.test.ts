import { describe, expect, it } from "vitest";
import {
  DiscussionEvidenceError,
  evidenceAlias,
  validateDiscussionTurnEvidence
} from "@/server/application/discussion-evidence";
import {
  createFixtureDiscussion,
  createFixtureState
} from "@/server/test-support/fixtures";
import type { DiscussionTurnPayload } from "@/server/domain/types";

function fixture() {
  const state = createFixtureState();
  const discussion = createFixtureDiscussion({
    workspaceId: state.workspace.id,
    conversationId: state.conversations[0].id
  });
  state.discussions.push(discussion);
  const turn = discussion.rounds[0].turns[0];
  const message = {
    id: "message-evidence",
    workspaceId: state.workspace.id,
    conversationId: discussion.conversationId,
    discussionId: discussion.id,
    discussionTurnId: turn.id,
    authorType: "employee" as const,
    authorId: turn.employeeId,
    content: "Evidence message",
    status: "complete" as const,
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  const task = {
    id: "task-evidence",
    workspaceId: state.workspace.id,
    conversationId: discussion.conversationId,
    title: "Evidence task",
    goal: "Preserve evidence.",
    assigneeIds: [turn.employeeId],
    status: "draft" as const,
    history: [],
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  const artifact = {
    id: "artifact-evidence",
    workspaceId: state.workspace.id,
    ownerType: "task" as const,
    ownerId: task.id,
    type: "text" as const,
    name: "Evidence artifact",
    content: "Evidence",
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  };
  const run = {
    id: "run-evidence",
    workspaceId: state.workspace.id,
    conversationId: discussion.conversationId,
    discussionId: discussion.id,
    triggerMessageId: message.id,
    memberSnapshot: [turn.employeeId],
    status: "completed" as const,
    createdAt: state.workspace.createdAt,
    completedAt: state.workspace.updatedAt
  };
  const toolEvent = {
    id: "event-tool-evidence",
    workspaceId: state.workspace.id,
    runId: run.id,
    sequence: 1,
    type: "tool_completed" as const,
    payload: { toolName: "fetch_url" },
    createdAt: state.workspace.createdAt
  };
  state.messages.push(message);
  state.tasks.push(task);
  state.artifacts.push(artifact);
  state.runs.push(run);
  state.runEvents.push(toolEvent);
  return { state, discussion, turn, message, task, artifact, toolEvent };
}

function payload(evidenceIds: string[]): DiscussionTurnPayload {
  return {
    summary: "Evidence-backed response",
    claims: [
      {
        statement: "A supported fact.",
        kind: "fact",
        evidenceIds,
        confidence: "high"
      }
    ],
    assumptions: [],
    risks: [],
    openQuestions: []
  };
}

describe("Discussion evidence", () => {
  it("resolves every supported evidence kind", () => {
    const value = fixture();
    const aliases = [
      evidenceAlias("turn", value.turn.id),
      evidenceAlias("message", value.message.id),
      evidenceAlias("task", value.task.id),
      evidenceAlias("artifact", value.artifact.id),
      evidenceAlias("tool_result", value.toolEvent.id),
      "external:https://example.com/source"
    ];

    const result = validateDiscussionTurnEvidence(
      value.state,
      value.discussion,
      payload(aliases)
    );

    expect(result.references.map((reference) => reference.kind)).toEqual([
      "turn",
      "message",
      "task",
      "artifact",
      "tool_result",
      "external_source"
    ]);
    expect(result.coverage).toEqual({
      claimCount: 1,
      claimsWithEvidence: 1
    });
  });

  it("rejects fact claims without evidence", () => {
    const value = fixture();
    expect(() =>
      validateDiscussionTurnEvidence(
        value.state,
        value.discussion,
        payload([])
      )
    ).toThrow(DiscussionEvidenceError);
  });

  it("keeps inference claims explicitly labelled without evidence", () => {
    const value = fixture();
    const result = validateDiscussionTurnEvidence(
      value.state,
      value.discussion,
      {
        ...payload([]),
        claims: [
          {
            statement: "A possible explanation.",
            kind: "inference",
            confidence: "medium"
          }
        ]
      }
    );

    expect(result.payload.claims[0]).toMatchObject({
      kind: "inference"
    });
    expect(result.payload.claims[0].evidenceIds).toBeUndefined();
  });

  it("rejects references outside the Discussion scope", () => {
    const value = fixture();
    expect(() =>
      validateDiscussionTurnEvidence(
        value.state,
        value.discussion,
        payload(["message:outside"])
      )
    ).toThrow("outside the Discussion");
  });
});
