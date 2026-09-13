import type {
  Discussion,
  DiscussionEvent
} from "@/server/domain/types";

export type DiscussionEventFactory = {
  id?: () => string;
  now?: () => string;
};

export function appendDiscussionEvent(
  discussion: Discussion,
  type: DiscussionEvent["type"],
  payload: Record<string, unknown> = {},
  factory: DiscussionEventFactory = {}
): DiscussionEvent {
  const events = (discussion.events ??= []);
  const id = factory.id ?? (() => crypto.randomUUID());
  const now = factory.now ?? (() => new Date().toISOString());
  const event: DiscussionEvent = {
    id: id(),
    workspaceId: discussion.workspaceId,
    discussionId: discussion.id,
    sequence:
      events.reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1,
    type,
    payload: {
      discussionStatus: discussion.status,
      budgetUsed: {
        usedRounds: discussion.rounds.filter(
          (round) => round.phase !== "synthesis"
        ).length,
        usedParticipants: discussion.participants.length,
        maxRounds: discussion.maxRounds
      },
      ...payload
    },
    createdAt: now()
  };
  events.push(event);
  return event;
}
