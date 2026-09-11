import { z } from "zod";
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
});

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

export const taskInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(8000),
  assigneeIds: z.array(z.string()).default([])
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
  assigneeIds: z.array(z.string()).optional(),
  goal: z.string().trim().min(1).max(8000).optional(),
  title: z.string().trim().min(1).max(120).optional()
});

export const artifactInputSchema = z.object({
  type: z.enum(["text", "markdown", "json"]),
  name: z.string().trim().min(1).max(120),
  content: z.string().max(200_000)
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected", "cancelled"])
});
