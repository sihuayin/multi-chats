import type { AppState, Conversation, Message } from "@/server/domain/types";
import {
  resolveEvidence,
  type EvidenceScope
} from "@/server/application/discussion-evidence";

import { citationAliasesIn } from "@/lib/citations";

/**
 * One citation as the Conversation surface renders it: a resolved alias
 * becomes a chip naming its Source with the passage available live; an
 * unresolvable one stays readable as the literal text the model wrote.
 */
export type MessageCitation = {
  messageId: string;
  alias: string;
  resolved: boolean;
  chunkId?: string;
  sourceTitle?: string;
  /** The chunk's current text, read live — correct because chunk text is
   *  append-only: a refresh supersedes, it never rewrites. */
  excerpt?: string;
  evidenceReferenceId?: string;
};

function isPublished(message: Message): boolean {
  // Deliberately the same line the Run transcript draws.
  return message.status === "complete";
}

/**
 * The Conversation's citable set as scope data, for resolving the citations
 * of ONE message: the chunks already cited by the Conversation's published
 * Messages before it, ∪ the chunks retrieved by the message's own Run.
 *
 * Write-time and read-time pass through this same builder, so they are the
 * same rule: the Run is immutable history, and excluding the message being
 * resolved from the scan reproduces the write-time view, when it was not
 * published yet. A chunk retrieved but never cited therefore never becomes
 * citable in a later Run, and a chunk belonging to another Conversation is
 * in neither set and never resolves here.
 */
export function conversationEvidenceScope(
  state: AppState,
  conversation: Conversation,
  message: Message
): EvidenceScope {
  const citableChunkIds = new Set<string>();

  for (const item of state.messages) {
    if (item.id === message.id) break;
    if (item.conversationId !== conversation.id || !isPublished(item)) {
      continue;
    }
    for (const alias of citationAliasesIn(item.content)) {
      if (alias.startsWith("external:")) {
        citableChunkIds.add(alias.slice("external:".length));
      }
    }
  }

  const runIds = message.runId ? [message.runId] : [];
  for (const event of state.runEvents) {
    if (event.type !== "tool_completed" || !runIds.includes(event.runId)) {
      continue;
    }
    const details = event.payload.details as
      | { returnedChunkIds?: unknown }
      | undefined;
    if (!details || !Array.isArray(details.returnedChunkIds)) continue;
    for (const id of details.returnedChunkIds) {
      if (typeof id === "string") citableChunkIds.add(id);
    }
  }

  return {
    conversationId: conversation.id,
    ownerId: conversation.id,
    turns: [],
    runIds,
    citableSourceIds: new Set<string>(),
    citableChunkIds
  };
}

/**
 * Persist the evidence references behind one Conversation message's
 * citations. Called inside the store update that completes the message, so
 * the record of what was cited survives independently of any Run's memory.
 * Citations are soft: an alias that does not resolve is left as literal
 * text, records nothing, and fails nothing — unlike a Discussion Turn, no
 * Conversation Run ever fails on evidence.
 */
export function recordMessageCitations(
  state: AppState,
  message: Message
): void {
  if (message.discussionId) return;
  const conversation = state.conversations.find(
    (item) => item.id === message.conversationId
  );
  if (!conversation) return;
  const scope = conversationEvidenceScope(state, conversation, message);
  const now = new Date().toISOString();
  for (const alias of citationAliasesIn(message.content)) {
    try {
      const { reference } = resolveEvidence(state, scope, alias, now);
      if (
        !state.evidenceReferences.some((item) => item.id === reference.id)
      ) {
        state.evidenceReferences.push(reference);
      }
    } catch {
      // Soft: nothing to record, nothing to fail.
    }
  }
}

/**
 * Resolve every citation of every published Conversation message for the
 * read path — the same rule as write-time, replayed from immutable history.
 */
export function resolveConversationCitations(
  state: AppState,
  conversationId: string
): MessageCitation[] {
  const conversation = state.conversations.find(
    (item) => item.id === conversationId
  );
  if (!conversation) return [];
  const now = new Date().toISOString();
  const citations: MessageCitation[] = [];
  for (const message of state.messages) {
    if (
      message.conversationId !== conversationId ||
      message.discussionId ||
      !isPublished(message)
    ) {
      continue;
    }
    const aliases = citationAliasesIn(message.content);
    if (aliases.length === 0) continue;
    const scope = conversationEvidenceScope(state, conversation, message);
    for (const alias of aliases) {
      try {
        const { reference } = resolveEvidence(state, scope, alias, now);
        const citation: MessageCitation = {
          messageId: message.id,
          alias,
          resolved: true,
          evidenceReferenceId: reference.id
        };
        if (
          reference.kind === "external_source" &&
          !/^https?:\/\//.test(reference.sourceId)
        ) {
          const chunk = state.chunks.find(
            (item) => item.id === reference.sourceId
          );
          if (chunk) {
            citation.chunkId = chunk.id;
            citation.excerpt = chunk.content;
            citation.sourceTitle = state.sources.find(
              (item) => item.id === chunk.sourceId
            )?.title;
          }
        }
        citations.push(citation);
      } catch {
        citations.push({ messageId: message.id, alias, resolved: false });
      }
    }
  }
  return citations;
}
