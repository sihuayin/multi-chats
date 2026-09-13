import { describe, expect, it } from "vitest";
import { validateDiscussion } from "@/server/application/discussion-domain";
import type { Discussion } from "@/server/domain/types";
import { createFixtureDiscussion } from "@/server/test-support/fixtures";

function discussion(): Discussion {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "discussion-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    title: "Choose a memory model",
    mode: "problem",
    language: "en",
    status: "draft",
    facilitatorParticipantId: "participant-3",
    maxRounds: 3,
    currentRound: 0,
    participants: [
      {
        id: "participant-1",
        employeeId: "employee-1",
        role: "analyst",
        objective: "Define the problem boundary.",
        order: 1
      },
      {
        id: "participant-2",
        employeeId: "employee-2",
        role: "skeptic",
        objective: "Challenge assumptions.",
        order: 2
      },
      {
        id: "participant-3",
        employeeId: "employee-3",
        role: "facilitator",
        objective: "Synthesize the decision.",
        order: 3
      }
    ],
    rounds: [],
    createdAt: now,
    updatedAt: now
  };
}

describe("Discussion domain invariants", () => {
  it("accepts a valid Discussion", () => {
    expect(() => validateDiscussion(discussion())).not.toThrow();
    expect(() => validateDiscussion(createFixtureDiscussion())).not.toThrow();
  });

  it("rejects invalid participant sets", () => {
    const oneParticipant = discussion();
    oneParticipant.participants = oneParticipant.participants.slice(0, 1);
    expect(() => validateDiscussion(oneParticipant)).toThrow(
      "Discussion requires 2 to 8 participants"
    );

    const duplicateEmployee = discussion();
    duplicateEmployee.participants[1].employeeId =
      duplicateEmployee.participants[0].employeeId;
    expect(() => validateDiscussion(duplicateEmployee)).toThrow(
      "Discussion participants must be unique"
    );

    const duplicateOrder = discussion();
    duplicateOrder.participants[1].order =
      duplicateOrder.participants[0].order;
    expect(() => validateDiscussion(duplicateOrder)).toThrow(
      "Discussion participant order must be unique"
    );
  });

  it("requires one Facilitator who is also a participant", () => {
    const missingRole = discussion();
    missingRole.participants[2].role = "analyst";
    expect(() => validateDiscussion(missingRole)).toThrow(
      "Discussion requires exactly one Facilitator participant"
    );

    const missing = discussion();
    missing.facilitatorParticipantId = "participant-4";
    expect(() => validateDiscussion(missing)).toThrow(
      "Facilitator must be a Discussion participant"
    );

    const notParticipant = discussion();
    notParticipant.facilitatorParticipantId = "participant-99";
    expect(() => validateDiscussion(notParticipant)).toThrow(
      "Facilitator must be a Discussion participant"
    );
  });

  it("validates Discussion statuses", () => {
    const invalidDiscussion = discussion();
    invalidDiscussion.status = "unknown" as Discussion["status"];
    expect(() => validateDiscussion(invalidDiscussion)).toThrow(
      "Discussion status is invalid"
    );

    const invalidRound = createFixtureDiscussion();
    invalidRound.rounds[0].status = "unknown" as never;
    expect(() => validateDiscussion(invalidRound)).toThrow(
      "Discussion round status is invalid"
    );

    const invalidPhase = createFixtureDiscussion();
    invalidPhase.rounds[0].phase = "unknown" as never;
    expect(() => validateDiscussion(invalidPhase)).toThrow(
      "Discussion round phase is invalid"
    );

    const invalidTurn = createFixtureDiscussion();
    invalidTurn.rounds[0].turns[0].status = "unknown" as never;
    expect(() => validateDiscussion(invalidTurn)).toThrow(
      "Discussion turn status is invalid"
    );
  });

  it("validates Round and Turn invariants", () => {
    const duplicateRound = createFixtureDiscussion();
    const duplicateNumber = structuredClone(duplicateRound.rounds[0]);
    duplicateNumber.id = `${duplicateNumber.id}-duplicate`;
    duplicateRound.rounds.push(duplicateNumber);
    expect(() => validateDiscussion(duplicateRound)).toThrow(
      "Discussion round numbers must be unique"
    );

    const duplicateTurn = createFixtureDiscussion();
    duplicateTurn.rounds[0].turns[1].employeeId =
      duplicateTurn.rounds[0].turns[0].employeeId;
    expect(() => validateDiscussion(duplicateTurn)).toThrow(
      "Discussion turn Employees must be unique"
    );

    const duplicateParticipant = createFixtureDiscussion();
    duplicateParticipant.participants[1].id =
      duplicateParticipant.participants[0].id;
    duplicateParticipant.rounds = [];
    expect(() => validateDiscussion(duplicateParticipant)).toThrow(
      "Discussion participant IDs must be unique"
    );

    const invalidSnapshot = createFixtureDiscussion();
    invalidSnapshot.rounds[0].participantSnapshot =
      invalidSnapshot.rounds[0].participantSnapshot.slice(0, 1);
    expect(() => validateDiscussion(invalidSnapshot)).toThrow(
      "Discussion round participant snapshot requires 2 to 8 participants"
    );

    const inactiveTurn = createFixtureDiscussion();
    inactiveTurn.rounds[0].activeParticipantIds = [
      inactiveTurn.rounds[0].participantSnapshot[0].id
    ];
    expect(() => validateDiscussion(inactiveTurn)).toThrow(
      "Discussion turn participant is not active in the round"
    );
  });
});
