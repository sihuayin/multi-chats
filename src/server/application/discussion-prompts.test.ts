import { describe, expect, it } from "vitest";
import {
  composeDiscussionPrompt,
  DISCUSSION_PROMPT_PROFILE_VERSION
} from "@/server/application/discussion-prompts";

describe("Discussion prompt profiles", () => {
  it("composes mode, role, phase, objective, and language", () => {
    const prompt = composeDiscussionPrompt({
      mode: "solution",
      role: "facilitator",
      phase: "synthesis",
      objective: "Choose the migration path.",
      language: "zh"
    });

    expect(prompt.version).toBe(DISCUSSION_PROMPT_PROFILE_VERSION);
    expect(prompt.version).toBe("discussion-prompts.v5");
    expect(prompt.systemInstructions).toContain("solution");
    expect(prompt.systemInstructions).toContain("facilitator");
    expect(prompt.systemInstructions).toContain("synthesis");
    expect(prompt.objectiveContext).toContain("Choose the migration path.");
    expect(prompt.systemInstructions).toContain("Chinese");
    expect(prompt.systemInstructions).toContain("Role differentiation");
    expect(prompt.responseInstructions).toContain("Discussion Brief JSON");
    expect(prompt.responseInstructions).toContain("minorityPositions");
    expect(prompt.responseInstructions).toContain("evidenceIds");
    expect(prompt.responseInstructions).toContain(
      "must be copied exactly"
    );
  });

  it("requires agreement, disagreement, and correction fields for cross-response", () => {
    const prompt = composeDiscussionPrompt({
      mode: "problem",
      role: "skeptic",
      phase: "cross_response",
      objective: "Challenge the root cause.",
      language: "en"
    });

    expect(prompt.responseInstructions).toContain("agreements");
    expect(prompt.responseInstructions).toContain("disagreements");
    expect(prompt.responseInstructions).toContain("corrections");
    expect(prompt.responseInstructions).toContain(
      "exact evidence IDs"
    );
    expect(prompt.responseInstructions).toContain(
      "unresolved disagreement"
    );
  });

  it("requires independent initial Positions and role-specific output", () => {
    const prompt = composeDiscussionPrompt({
      mode: "requirements",
      role: "researcher",
      phase: "positions",
      objective: "Define the boundary.",
      language: "en"
    });

    expect(prompt.responseInstructions).toContain(
      "independent initial position"
    );
    expect(prompt.responseInstructions).toContain(
      "Do not copy another Participant"
    );
  });
});
