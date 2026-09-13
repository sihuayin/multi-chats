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
