import type { Run } from "@/server/domain/types";

/**
 * Deep links back to the work an entity belongs to, shared by the views
 * that point at it.
 */
export function runHref(run: Run): string {
  const query = new URLSearchParams({ conversation: run.conversationId });
  if (run.taskId) query.set("task", run.taskId);
  if (run.discussionId) {
    query.set("view", "discussion");
    query.set("discussion", run.discussionId);
  }
  return `/?${query.toString()}`;
}

export function discussionHref(
  conversationId: string,
  discussionId: string
): string {
  return `/?${new URLSearchParams({
    view: "discussion",
    conversation: conversationId,
    discussion: discussionId
  })}`;
}

export function conversationHref(conversationId: string): string {
  return `/?${new URLSearchParams({ conversation: conversationId })}`;
}

export function taskHref(conversationId: string, taskId: string): string {
  return `/?${new URLSearchParams({
    conversation: conversationId,
    task: taskId
  })}`;
}
