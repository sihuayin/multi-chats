import { z } from "zod";
import type {
  DiscussionRoundPhase,
  DiscussionTurnPayload
} from "@/server/domain/types";
import { parseJsonObject } from "@/server/application/structured-output";

const confidenceSchema = z.enum(["low", "medium", "high"]);

const payloadSchema = z
  .object({
    summary: z.string().trim().min(1),
    claims: z
      .array(
        z
          .object({
            statement: z.string().trim().min(1),
            evidence: z.string().optional(),
            confidence: confidenceSchema
          })
          .strict()
      ),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
    openQuestions: z.array(z.string()),
    agreements: z.array(z.string()).optional(),
    disagreements: z.array(z.string()).optional(),
    corrections: z.array(z.string()).optional()
  })
  .strict();

export function parseDiscussionTurnPayload(
  raw: string,
  phase: DiscussionRoundPhase
): DiscussionTurnPayload {
  const parsed = payloadSchema.safeParse(
    parseJsonObject(raw, "Discussion Turn")
  );
  if (!parsed.success) {
    throw new Error("Discussion Turn JSON is invalid");
  }
  if (
    phase === "cross_response" &&
    !isCrossResponsePayloadComplete(parsed.data)
  ) {
    throw new Error("Cross-response Turn payload is invalid");
  }
  return parsed.data;
}

export function isCrossResponsePayloadComplete(
  payload: Pick<
    DiscussionTurnPayload,
    "agreements" | "disagreements" | "corrections"
  >
): boolean {
  return (
    payload.agreements !== undefined &&
    payload.disagreements !== undefined &&
    payload.corrections !== undefined
  );
}
