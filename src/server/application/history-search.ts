import type { AppState } from "@/server/domain/types";
import {
  excludedConversationCount,
  rankHistory,
  searchableHistory
} from "@/server/application/history-retrieval";

/**
 * The cap on one result, in code points — the number #193 re-justified
 * rather than inherited: no adapter truncates at any size, and 40,000 code
 * points is a product choice sized against the context window, not against
 * the corpus. Counted at item boundaries: a History item is the atomic unit
 * of citation, so a slice would leave an intact, copyable alias pointing at
 * text the model only partly saw.
 *
 * One deliberate exception: the FIRST item is always returned whole, even
 * when it alone exceeds the cap — excluding an over-cap item whole could
 * produce an empty result, which the never-empty rule forbids, and the
 * largest item is usually the Brief that is the answer. A result that
 * overshoots this way is not a truncation and earns no notice.
 */
export const SEARCH_HISTORY_MAX_RESULT_CODEPOINTS = 40_000;
/** Headroom kept out of the item budget so header and notice always fit. */
const RESULT_OVERHEAD_RESERVE_CODEPOINTS = 400;

export type HistorySearchOutcome = {
  status: "success";
  content: string;
  query: string;
  /** In rank order — this ordering is the effort's ranking record. */
  returnedItemIds: string[];
  truncated: boolean;
  candidateCount: number;
};

function codePointLength(value: string): number {
  return [...value].length;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function authorName(state: AppState, authorType: string, authorId: string): string {
  if (authorType === "user") return "User";
  if (authorType === "system") return "System";
  return (
    state.employees.find((employee) => employee.id === authorId)?.name ??
    "Employee"
  );
}

function excludedLine(state: AppState, conversationId: string): string {
  const excluded = excludedConversationCount(state, conversationId);
  if (excluded === 0) return "";
  return `\n${formatCount(excluded)} Conversation${excluded === 1 ? " is" : "s are"} excluded from history search.`;
}

/**
 * Search the Workspace's own history — the Messages, Tasks, and Artifacts of
 * every Conversation this Run may draw on — and return citable text.
 *
 * Never leaves the process and never throws: every path returns non-empty
 * text that states its own outcome, because some providers carry no tool
 * error field. Ranking is `rankHistory` over `searchableHistory`, both pure
 * and deterministic; membership is `coverage > 0` inside the ranker, so a
 * query matching nothing is a normal result, not an error.
 */
export function searchHistory(
  state: AppState,
  conversationId: string,
  query: string
): HistorySearchOutcome {
  const corpus = searchableHistory(state, conversationId);

  if (corpus.length === 0) {
    return {
      status: "success",
      content:
        "This Workspace has no searchable history." +
        excludedLine(state, conversationId),
      query,
      returnedItemIds: [],
      truncated: false,
      candidateCount: 0
    };
  }

  const ranked = rankHistory(corpus, query);
  if (ranked.length === 0) {
    return {
      status: "success",
      content:
        `No history items matched "${query}".` +
        excludedLine(state, conversationId),
      query,
      returnedItemIds: [],
      truncated: false,
      candidateCount: corpus.length
    };
  }

  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const discussionById = new Map(
    state.discussions.map((discussion) => [discussion.id, discussion])
  );
  const conversationTitle = (id: string | undefined): string =>
    state.conversations.find((conversation) => conversation.id === id)
      ?.title ?? "Unknown Conversation";

  // The alias carries no provenance, so the per-item line is load-bearing:
  // it is the only place the model learns where an item came from.
  const blockFor = (itemId: string): string => {
    const message = state.messages.find((item) => item.id === itemId);
    if (message) {
      const author = authorName(
        state,
        message.authorType,
        message.authorId
      );
      const date = message.createdAt.slice(0, 10);
      return [
        `message:${message.id}`,
        `Message — ${author}, ${conversationTitle(message.conversationId)}, ${date}`,
        message.content
      ].join("\n");
    }
    const task = taskById.get(itemId);
    if (task) {
      return [
        `task:${task.id}`,
        `Task — ${task.status}, ${conversationTitle(task.conversationId)}`,
        `${task.title}\n${task.goal}`
      ].join("\n");
    }
    const artifact = state.artifacts.find((item) => item.id === itemId);
    if (artifact) {
      const ownerConversationId =
        artifact.ownerType === "task"
          ? taskById.get(artifact.ownerId)?.conversationId
          : discussionById.get(artifact.ownerId)?.conversationId;
      return [
        `artifact:${artifact.id}`,
        `Artifact — ${artifact.name}, ${conversationTitle(ownerConversationId)}`,
        // Verbatim, whatever `type` says: a Brief arrives as raw JSON,
        // because a projection would silently drop whatever v3 adds.
        artifact.content
      ].join("\n");
    }
    // Unreachable: every ranked id came from these three collections.
    return itemId;
  };

  // Assemble at item boundaries. The first item is returned whole whatever
  // its size; the cap bounds only the tail.
  const itemBudget =
    SEARCH_HISTORY_MAX_RESULT_CODEPOINTS - RESULT_OVERHEAD_RESERVE_CODEPOINTS;
  const blocks: string[] = [];
  const returnedItemIds: string[] = [];
  let used = 0;
  for (let index = 0; index < ranked.length; index += 1) {
    const block = blockFor(ranked[index].id);
    const blockLength =
      codePointLength(block) + (blocks.length > 0 ? 2 : 0);
    // The search stops when the next item would not fit; it never skips one
    // to squeeze a smaller item in behind it.
    if (index > 0 && used + blockLength > itemBudget) break;
    blocks.push(block);
    used += blockLength;
    returnedItemIds.push(ranked[index].id);
  }
  const truncated = returnedItemIds.length < ranked.length;

  const header = [
    `search_history — query: "${query}"`,
    `Returned ${formatCount(returnedItemIds.length)} of ${formatCount(corpus.length)} searchable history items.`,
    "",
    "Cite an item by copying its alias exactly as shown — the prefix is part of it (message:, task:, or artifact:)."
  ].join("\n");
  // The notice reports the size of the hole, never an invitation to reason
  // about what is in it: a count, no breakdown, no dropped aliases.
  const notice = truncated
    ? `\n\nTruncated: ${formatCount(ranked.length - returnedItemIds.length)} further matching history items were not returned; this result reached its size limit.`
    : "";

  return {
    status: "success",
    content: `${header}\n\n${blocks.join("\n\n")}${notice}`,
    query,
    returnedItemIds,
    truncated,
    candidateCount: corpus.length
  };
}
