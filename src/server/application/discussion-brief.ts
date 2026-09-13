import { z } from "zod";
import { DISCUSSION_PROMPT_PROFILE_VERSION } from "@/server/application/discussion-prompts";
import { parseJsonObject } from "@/server/application/structured-output";
import type {
  AppState,
  Artifact,
  Discussion
} from "@/server/domain/types";

export const DISCUSSION_BRIEF_SCHEMA_VERSION = 1;

const confidenceSchema = z.enum(["low", "medium", "high"]);

const briefSchema = z
  .object({
    schemaVersion: z.literal(DISCUSSION_BRIEF_SCHEMA_VERSION),
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
    facts: z.array(
      z
        .object({
          statement: z.string().trim().min(1),
          evidence: z.string().optional()
        })
        .strict()
    ),
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
  })
  .strict();

export type DiscussionBrief = z.infer<typeof briefSchema>;

export function parseDiscussionBrief(raw: string): DiscussionBrief {
  const parsed = briefSchema.safeParse(
    parseJsonObject(raw, "Discussion Brief")
  );
  if (!parsed.success) {
    throw new Error("Discussion Brief JSON is invalid");
  }
  const optionIds = new Set(
    parsed.data.options.map((option) => option.id)
  );
  if (optionIds.size !== parsed.data.options.length) {
    throw new Error("Discussion Brief option IDs must be unique");
  }
  if (!optionIds.has(parsed.data.recommendation.optionId)) {
    throw new Error(
      "Discussion Brief recommendation must reference an option"
    );
  }
  return parsed.data;
}

export function createDiscussionBriefRevision(
  state: Pick<AppState, "artifacts" | "workspace">,
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
  if (brief.promptProfileVersion !== DISCUSSION_PROMPT_PROFILE_VERSION) {
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
    schemaVersion: DISCUSSION_BRIEF_SCHEMA_VERSION,
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
