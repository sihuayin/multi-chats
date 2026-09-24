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
  /**
   * The second way a citation fails: it IS in the citable set, but its
   * target died with its Conversation. It stays a chip — not raw text, no
   * badge — listed under "From elsewhere" with no title, no door, and no
   * passage, because the target's text is gone with it (#194).
   */
  dangling?: boolean;
  /** The originating Conversation of a resolved History-item citation. */
  locator?: string;
  chunkId?: string;
  sourceTitle?: string;
  /** The chunk's current text, read live — correct because chunk text is
   *  append-only: a refresh supersedes, it never rewrites. */
  excerpt?: string;
  evidenceReferenceId?: string;
  /**
   * History-item citations only. The title resolves at read time from the
   * reference's `locator` — nothing is snapshotted and no title is stored,
   * so a dangling reference (Conversation gone) simply has no title and the
   * door cannot open (#211's state).
   */
  originConversationId?: string;
  originConversationTitle?: string;
  /** Display author of a cited Message ("User" / "System" / employee name). */
  authorName?: string;
  /** The cited item's creation time, for the panel's provenance line. */
  itemDate?: string;
  /** A cited Message's id, so the door can mark it in its Conversation. */
  targetMessageId?: string;
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
  const citableIds = new Set<string>();

  // Re-citable tier: anything one of this Conversation's published Messages
  // before this one has already cited — History items now alongside Chunks.
  // A linear scan, not the ledger: reference rows are deterministic and
  // global and carry no Conversation. No existence filter — the citable set
  // is a rule, not a snapshot.
  for (const item of state.messages) {
    if (item.id === message.id) break;
    if (item.conversationId !== conversation.id || !isPublished(item)) {
      continue;
    }
    // Only what an Employee wrote is a citation. A User's prose is not: a
    // bracketed alias pasted into a question would otherwise put an
    // invented id into the citable set and flip how the answer renders,
    // where #180 keeps a never-citable alias literal.
    if (item.authorType === "user") continue;
    for (const alias of citationAliasesIn(item.content)) {
      if (alias.startsWith("external:")) {
        citableChunkIds.add(alias.slice("external:".length));
      } else if (/^(?:message|task|artifact):/.test(alias)) {
        citableIds.add(alias.slice(alias.indexOf(":") + 1));
      }
    }
  }

  // Retrieved tier: what this message's own Run retrieved, from both
  // retrieval Tools' completion-event details.
  const runIds = message.runId ? [message.runId] : [];
  for (const event of state.runEvents) {
    if (event.type !== "tool_completed" || !runIds.includes(event.runId)) {
      continue;
    }
    const details = event.payload.details as
      | { returnedChunkIds?: unknown; returnedItemIds?: unknown }
      | undefined;
    if (!details) continue;
    if (Array.isArray(details.returnedChunkIds)) {
      for (const id of details.returnedChunkIds) {
        if (typeof id === "string") citableChunkIds.add(id);
      }
    }
    if (Array.isArray(details.returnedItemIds)) {
      for (const id of details.returnedItemIds) {
        if (typeof id === "string") citableIds.add(id);
      }
    }
  }

  return {
    conversationId: conversation.id,
    turns: [],
    runIds,
    citableSourceIds: new Set<string>(),
    citableChunkIds,
    citableIds
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
          ...(reference.locator !== undefined
            ? { locator: reference.locator }
            : {}),
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
        if (
          reference.kind === "message" ||
          reference.kind === "task" ||
          reference.kind === "artifact"
        ) {
          // The door and the provenance line, resolved at read time.
          if (reference.locator !== undefined) {
            citation.originConversationId = reference.locator;
            const origin = state.conversations.find(
              (item) => item.id === reference.locator
            );
            if (origin) citation.originConversationTitle = origin.title;
          }
          if (reference.kind === "message") {
            const cited = state.messages.find(
              (item) => item.id === reference.sourceId
            );
            if (cited) {
              citation.excerpt = cited.content;
              citation.itemDate = cited.createdAt;
              citation.targetMessageId = cited.id;
              citation.authorName =
                cited.authorType === "user"
                  ? "User"
                  : cited.authorType === "system"
                    ? "System"
                    : state.employees.find(
                        (employee) => employee.id === cited.authorId
                      )?.name ?? "Employee";
            }
          } else if (reference.kind === "task") {
            const cited = state.tasks.find(
              (item) => item.id === reference.sourceId
            );
            if (cited) {
              citation.excerpt = `${cited.title}\n${cited.goal}`;
              citation.itemDate = cited.createdAt;
              citation.authorName = cited.status;
            }
          } else {
            const cited = state.artifacts.find(
              (item) => item.id === reference.sourceId
            );
            if (cited) {
              citation.excerpt = cited.content;
              citation.itemDate = cited.createdAt;
              citation.authorName = cited.name;
            }
          }
        }
        citations.push(citation);
      } catch {
        // Two ways a citation fails to resolve, and they render
        // differently. In the citable set but the target is gone — a real
        // citation whose Conversation was deleted — stays a CHIP with no
        // origin and nothing to show. Not in the citable set — a
        // hallucinated or wrong alias — stays literal text (#180).
        const separator = alias.indexOf(":");
        const prefix = separator > 0 ? alias.slice(0, separator) : "";
        const sourceId = separator > 0 ? alias.slice(separator + 1) : "";
        const dangling =
          (prefix === "external" &&
            scope.citableChunkIds?.has(sourceId) === true) ||
          ((prefix === "message" ||
            prefix === "task" ||
            prefix === "artifact") &&
            scope.citableIds?.has(sourceId) === true);
        citations.push(
          dangling
            ? { messageId: message.id, alias, resolved: false, dangling: true }
            : { messageId: message.id, alias, resolved: false }
        );
      }
    }
  }
  return citations;
}
