import { describe, expect, it } from "vitest";
import { parseDiscussionTurnPayload } from "@/server/application/discussion-turn-payload";

const position = {
  summary: "Keep the current state store.",
  claims: [
      {
        statement: "The current store already persists Discussions.",
        evidence: "Schema v2",
        kind: "inference",
        confidence: "high"
    }
  ],
  assumptions: ["The workspace remains single-tenant."],
  risks: ["Migration mistakes could corrupt state."],
  openQuestions: ["When should PostgreSQL become mandatory?"]
};

describe("Discussion Turn payload", () => {
  it("parses a fenced Positions payload", () => {
    expect(
      parseDiscussionTurnPayload(
        `\`\`\`json\n${JSON.stringify(position)}\n\`\`\``,
        "positions"
      )
    ).toEqual(position);
  });

  it("accepts structured evidence references and claim kinds", () => {
    const payload = {
      ...position,
      claims: [
        {
          statement: "The current store already persists Discussions.",
          evidence: "Schema migration test",
          evidenceIds: ["evidence-1"],
          kind: "fact",
          confidence: "high"
        }
      ]
    };

    expect(
      parseDiscussionTurnPayload(JSON.stringify(payload), "positions")
    ).toEqual(payload);
  });

  it("requires Cross-response agreements, disagreements, and corrections", () => {
    expect(() =>
      parseDiscussionTurnPayload(JSON.stringify(position), "cross_response")
    ).toThrow("Cross-response Turn payload is invalid");
  });

  it("rejects payloads with invalid claim confidence", () => {
    expect(() =>
      parseDiscussionTurnPayload(
        JSON.stringify({
          ...position,
          claims: [
            {
              statement: "Unsupported claim",
              confidence: "certain"
            }
          ]
        }),
        "positions"
      )
    ).toThrow("Discussion Turn JSON is invalid");
  });
});

describe("Advisory convergence recommendation", () => {
  const cross = {
    summary: "Positions are stable.",
    claims: [
      {
        statement: "The store already persists Discussions.",
        evidenceIds: ["external:https://example.com/schema"],
        kind: "fact" as const,
        confidence: "high" as const
      }
    ],
    assumptions: [],
    risks: [],
    openQuestions: [],
    agreements: ["The schema is sufficient."],
    disagreements: [],
    corrections: []
  };

  it("accepts an optional convergence recommendation on cross-response Turns", () => {
    const payload = {
      ...cross,
      convergence: {
        recommended: true,
        reasons: ["No new supported claims this Round."]
      }
    };
    expect(
      parseDiscussionTurnPayload(JSON.stringify(payload), "cross_response")
    ).toEqual(payload);
  });

  it("rejects malformed convergence recommendations", () => {
    expect(() =>
      parseDiscussionTurnPayload(
        JSON.stringify({
          ...cross,
          convergence: { recommended: "yes", reasons: [] }
        }),
        "cross_response"
      )
    ).toThrow();
    expect(() =>
      parseDiscussionTurnPayload(
        JSON.stringify({
          ...cross,
          convergence: { recommended: true, reasons: [], extra: 1 }
        }),
        "cross_response"
      )
    ).toThrow();
  });
});
