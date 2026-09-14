import { z } from "zod";
import { DISCUSSION_PROMPT_PROFILE_VERSION } from "@/server/application/discussion-prompts";
import { validateDiscussionBriefEvidence } from "@/server/application/discussion-evidence";
import { parseJsonObject } from "@/server/application/structured-output";
import type {
  AppState,
  Artifact,
  Discussion
} from "@/server/domain/types";

export const DISCUSSION_BRIEF_SCHEMA_VERSION = 2;

const confidenceSchema = z.enum(["low", "medium", "high"]);

const commonShape = {
    promptProfileVersion: z
      .string()
      .regex(/^discussion-prompts\.v\d+$/),
    discussionId: z.string().trim().min(1),
    mode: z.enum(["requirements", "problem", "solution", "review"]),
    title: z.string().trim().min(1),
    problem: z
      .object({
        statement: z.string().trim().min(1),
        goals: z.array(z.string()),
        nonGoals: z.array(z.string())
      })
      .strict(),
    context: z.string().trim().min(1),
    constraints: z.array(
      z
        .object({
          statement: z.string().trim().min(1),
          kind: z.string().optional()
        })
        .strict()
    ),
    assumptions: z.array(z.string()),
    disagreements: z.array(
      z
        .object({
          topic: z.string().trim().min(1),
          positions: z.array(
            z
              .object({
                employeeId: z.string().trim().min(1),
                position: z.string().trim().min(1)
              })
              .strict()
          )
        })
        .strict()
    ),
    options: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          title: z.string().trim().min(1),
          summary: z.string().trim().min(1),
          benefits: z.array(z.string()),
          costs: z.array(z.string()),
          risks: z.array(z.string())
        })
        .strict()
    ),
    recommendation: z
      .object({
        optionId: z.string().trim().min(1),
        rationale: z.string().trim().min(1),
        confidence: confidenceSchema
      })
      .strict(),
    actions: z.array(
      z
        .object({
          title: z.string().trim().min(1),
          description: z.string().trim().min(1),
          suggestedOwner: z.string().optional(),
          priority: z.enum(["low", "medium", "high"]).optional()
        })
        .strict()
    ),
    openQuestions: z.array(z.string())
};

const briefV1Schema = z
  .object({
    ...commonShape,
    schemaVersion: z.literal(1),
    facts: z.array(
      z
        .object({
          statement: z.string().trim().min(1),
          evidence: z.string().optional()
        })
        .strict()
    )
  })
  .strict();

const briefV2Schema = z
  .object({
    ...commonShape,
    schemaVersion: z.literal(2),
    facts: z.array(
      z
        .object({
          statement: z.string().trim().min(1),
          kind: z.literal("fact"),
          evidenceIds: z.array(z.string().trim().min(1)).min(1)
        })
        .strict()
    ),
    minorityPositions: z.array(z.string())
  })
  .strict();

export type DiscussionBriefV1 = z.infer<typeof briefV1Schema>;
export type DiscussionBriefV2 = z.infer<typeof briefV2Schema>;
export type DiscussionBrief = DiscussionBriefV1 | DiscussionBriefV2;

function validateReferences(brief: DiscussionBrief): DiscussionBrief {
  const optionIds = new Set(
    brief.options.map((option) => option.id)
  );
  if (optionIds.size !== brief.options.length) {
    throw new Error("Discussion Brief option IDs must be unique");
  }
  if (!optionIds.has(brief.recommendation.optionId)) {
    throw new Error(
      "Discussion Brief recommendation must reference an option"
    );
  }
  return brief;
}

export function parseDiscussionBrief(raw: string): DiscussionBrief {
  const value = parseJsonObject(raw, "Discussion Brief");
  const parsedV2 = briefV2Schema.safeParse(value);
  if (parsedV2.success) return validateReferences(parsedV2.data);
  const parsedV1 = briefV1Schema.safeParse(value);
  if (parsedV1.success) return validateReferences(parsedV1.data);
  throw new Error("Discussion Brief JSON is invalid");
}

export function createDiscussionBriefRevision(
  state: Pick<
    AppState,
    | "artifacts"
    | "workspace"
    | "messages"
    | "runs"
    | "tasks"
    | "runEvents"
    | "discussions"
    | "evidenceReferences"
  >,
  discussion: Discussion,
  raw: string,
  factory: {
    id?: () => string;
    now?: () => string;
  } = {}
): {
  artifact: Artifact;
  brief: DiscussionBrief;
} {
  const brief = parseDiscussionBrief(raw);
  if (
    brief.promptProfileVersion !== DISCUSSION_PROMPT_PROFILE_VERSION &&
    !(
      brief.schemaVersion === 1 &&
      brief.promptProfileVersion === "discussion-prompts.v1"
    )
  ) {
    throw new Error("Discussion Brief prompt profile is unsupported");
  }
  if (
    brief.discussionId !== discussion.id ||
    brief.mode !== discussion.mode
  ) {
    throw new Error("Discussion Brief does not match the Discussion");
  }
  const previous = discussion.latestBriefArtifactId
    ? state.artifacts.find(
        (artifact) =>
          artifact.id === discussion.latestBriefArtifactId
      )
    : undefined;
  if (
    previous &&
    (previous.kind !== "discussion_brief" ||
      previous.ownerType !== "discussion" ||
      previous.ownerId !== discussion.id)
  ) {
    throw new Error("Previous Discussion Brief revision is invalid");
  }
  if (brief.schemaVersion === 2) {
    const references = validateDiscussionBriefEvidence(
      state as AppState,
      discussion,
      brief
    );
    for (const reference of references) {
      if (
        !state.evidenceReferences.some(
          (item) => item.id === reference.id
        )
      ) {
        state.evidenceReferences.push(reference);
      }
    }
  }

  const id = factory.id ?? (() => crypto.randomUUID());
  const now = factory.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const artifact: Artifact = {
    id: id(),
    workspaceId: state.workspace.id,
    ownerType: "discussion",
    ownerId: discussion.id,
    type: "json",
    name: `${discussion.title} Brief`,
    content: JSON.stringify(brief),
    kind: "discussion_brief",
    schemaVersion: brief.schemaVersion,
    revision: (previous?.revision ?? 0) + 1,
    previousArtifactId: previous?.id,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  state.artifacts.push(artifact);
  discussion.latestBriefArtifactId = artifact.id;
  discussion.updatedAt = timestamp;
  return { artifact, brief };
}
