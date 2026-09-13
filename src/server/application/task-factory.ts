import type { Task } from "@/server/domain/types";

export function createDraftTask(input: {
  workspaceId: string;
  conversationId: string;
  title: string;
  goal: string;
  assigneeIds: string[];
  discussionId?: string;
  confirmedBriefArtifactId?: string;
  now: string;
  id?: string;
}): Task {
  return {
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    ...(input.discussionId ? { discussionId: input.discussionId } : {}),
    ...(input.confirmedBriefArtifactId
      ? { confirmedBriefArtifactId: input.confirmedBriefArtifactId }
      : {}),
    title: input.title,
    goal: input.goal,
    assigneeIds: input.assigneeIds,
    status: "draft",
    history: [{ status: "draft", at: input.now, actorId: "user" }],
    createdAt: input.now,
    updatedAt: input.now
  };
}
