import { z } from "zod";
import { artifactTypes } from "@/lib/artifact-types";
import { PROVIDER_IDS } from "@/lib/provider-catalog";

export const providerIdSchema = z.enum(PROVIDER_IDS);

export const providerInputSchema = z.object({
  provider: providerIdSchema,
  label: z.string().trim().min(1).max(80),
  credential: z.string().trim().min(1)
});

export const employeeInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  identity: z.string().trim().min(1).max(4000),
  providerCredentialId: z.string().min(1),
  modelId: z.string().trim().min(1),
  skillIds: z.array(z.string()).default([]),
  active: z.boolean().default(true)
});

export const skillInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(8000),
  inputs: z.array(z.string().trim().min(1)).default([]),
  outputs: z.array(z.string().trim().min(1)).default([]),
  toolNames: z.array(z.string().trim().min(1)).default([])
}).strict();

export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(z.string()).default([])
});

export const conversationInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  groupId: z.string().optional(),
  memberIds: z.array(z.string()).default([])
});

export const messageInputSchema = z.object({
  content: z.string().trim().min(1).max(20_000)
});

export const discussionParticipantInputSchema = z.object({
  id: z.string().trim().min(1),
  employeeId: z.string().trim().min(1),
  role: z.enum([
    "analyst",
    "researcher",
    "skeptic",
    "designer",
    "facilitator"
  ]),
  objective: z.string().trim().min(1).max(2000),
  order: z.number().int().positive()
});

export const phaseRunInputSchema = z.object({
  discussionId: z.string().trim().min(1),
  roundId: z.string().trim().min(1),
  participantSnapshot: z
    .array(discussionParticipantInputSchema)
    .min(2)
    .max(8),
  context: z.string().trim().min(1).max(20_000),
  purpose: z.string().trim().min(1).max(4000)
}).strict();

export const discussionCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  mode: z.enum(["requirements", "problem", "solution", "review"]),
  language: z.enum(["en", "zh"]).default("en"),
  participants: z
    .array(
      z.object({
        employeeId: z.string().trim().min(1),
        role: z.enum([
          "analyst",
          "researcher",
          "skeptic",
          "designer",
          "facilitator"
        ]),
        objective: z.string().trim().min(1).max(2000).optional()
      })
    )
    .min(2)
    .max(8),
  facilitatorId: z.string().trim().min(1),
  maxRounds: z.number().int().min(1).max(5).default(3),
  sourceTaskId: z.string().trim().min(1).optional()
}).strict();

export const discussionPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(["requirements", "problem", "solution", "review"]).optional(),
  language: z.enum(["en", "zh"]).optional(),
  participants: discussionCreateSchema.shape.participants.optional(),
  facilitatorId: z.string().trim().min(1).optional(),
  maxRounds: z.number().int().min(1).max(5).optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one Discussion field is required"
);

export const discussionConstraintsSchema = z.object({
  constraints: z.array(z.string().trim().min(1)).optional(),
  questions: z.array(z.string().trim().min(1)).optional(),
  note: z.string().trim().min(1).max(4000).optional()
}).strict().refine(
  (value) =>
    value.constraints !== undefined ||
    value.questions !== undefined ||
    value.note !== undefined,
  "At least one constraint field is required"
);

export const discussionSkipSchema = z.object({
  employeeId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(1000).optional()
}).strict();

export const discussionConfirmSchema = z.object({
  briefArtifactId: z.string().trim().min(1).optional(),
  selectedOptionId: z.string().trim().min(1).optional(),
  taskTitle: z.string().trim().min(1).max(120).optional(),
  taskGoal: z.string().trim().min(1).max(8000).optional(),
  assigneeIds: z.array(z.string().trim().min(1)).optional()
}).strict();

export const discussionStopSchema = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
  operator: z.string().trim().min(1).max(120).optional()
}).strict();

export const discussionRetrySchema = z.object({
  participantIds: z.array(z.string().trim().min(1)).optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  operator: z.string().trim().min(1).max(120).optional()
}).strict();

export const discussionSynthesizeSchema = z.object({
  force: z.boolean().optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  operator: z.string().trim().min(1).max(120).optional()
}).strict();

export const emptyCommandSchema = z.object({}).strict();

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(8000),
  assigneeIds: z.array(z.string()).min(1)
});

export const taskStatusSchema = z.enum([
  "draft",
  "in_progress",
  "blocked",
  "review",
  "completed",
  "cancelled"
]);

export const taskPatchSchema = z.object({
  status: taskStatusSchema.optional(),
  assigneeIds: z.array(z.string()).min(1).optional(),
  goal: z.string().trim().min(1).max(8000).optional(),
  title: z.string().trim().min(1).max(120).optional()
});

export const artifactInputSchema = z.object({
  type: z.enum(artifactTypes),
  name: z.string().trim().min(1).max(120),
  content: z.string().max(200_000)
});

export const artifactPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    content: z.string().max(200_000).optional()
  })
  .refine(
    (value) => value.name !== undefined || value.content !== undefined,
    "At least one Artifact field is required"
  );

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected", "cancelled"])
});
