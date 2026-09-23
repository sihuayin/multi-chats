import type { AppState, IsoDate } from "@/server/domain/types";
import {
  longestPhraseMatch,
  tokenize
} from "@/server/application/source-retrieval";

/**
 * One History item as the ranker sees it — a projection, not the glossary's
 * unit. The caller decides which stored field becomes `content`, and collapses
 * an Artifact's type to the one distinction ranking makes: a Markdown Artifact
 * is `text`, because it tokenises the same way.
 */
export type HistoryRankItem = {
  id: string;
  content: string;
  contentFormat: "text" | "json";
  createdAt: IsoDate;
};

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectStrings(element, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const element of Object.values(value)) collectStrings(element, into);
  }
}

/**
 * A History item's text as one token array per field, so a phrase can never
 * span two of them.
 *
 * A JSON item is tokenised by its string *values* only. Its structural keys
 * are ordinary English that a query written in the register of a Discussion
 * Brief hits, and a single matched key scores what the rarest term in the
 * corpus scores — so leaving them in ranks an off-topic item above an on-topic
 * one.
 */
function tokenSegmentsOf(item: HistoryRankItem): string[][] {
  if (item.contentFormat !== "json") return [tokenize(item.content)];
  try {
    const values: string[] = [];
    collectStrings(JSON.parse(item.content), values);
    return values.map(tokenize);
  } catch {
    // Stored JSON is validated on write, so this is defensive only. Content
    // that no longer parses is still content, and dropping it out of the
    // corpus would be worse than tokenising it literally.
    return [tokenize(item.content)];
  }
}

/**
 * Deterministic keyword ranking for the Workspace's own history: a sibling of
 * `rankChunks` for a corpus with authorship, timestamps, and no document
 * index.
 *
 * Two deliberate differences from `rankChunks`. An item matching no query term
 * is not a search result and is not returned, so an empty query yields an
 * empty list rather than the corpus. And the query is deduplicated, so
 * `coverage` counts the distinct query terms an item holds however many times
 * the model repeated one.
 */
export function rankHistory(
  items: HistoryRankItem[],
  query: string
): HistoryRankItem[] {
  const queryTerms = [...new Set(tokenize(query))];
  const tokenized = items.map((candidate) => {
    const segments = tokenSegmentsOf(candidate);
    const tokens = segments.flat();
    return { candidate, segments, tokens, tokenSet: new Set(tokens) };
  });
  const documentCount = Math.max(1, tokenized.length);
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      tokenized.filter((entry) => entry.tokenSet.has(term)).length
    );
  }

  return tokenized
    .map(({ candidate, segments, tokens, tokenSet }) => {
      let relevance = 0;
      let coverage = 0;
      for (const term of queryTerms) {
        if (!tokenSet.has(term)) continue;
        coverage += 1;
        relevance += Math.log(
          1 + documentCount / Math.max(1, documentFrequency.get(term) ?? 0)
        );
      }
      // The phrase boost joins the IDF sum before the division, so quoting the
      // query back is not a way around the length penalty.
      let phrase = 0;
      for (const segment of segments) {
        phrase = Math.max(phrase, longestPhraseMatch(segment, queryTerms));
      }
      const numerator = phrase >= 2 ? relevance + phrase : relevance;
      // Length is not free: without this a Message padded with chatter scores
      // exactly what the same sentence alone scores.
      const score = coverage > 0 ? numerator / Math.log(1 + tokens.length) : 0;
      return { candidate, score, coverage };
    })
    .filter((entry) => entry.coverage > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.coverage - left.coverage ||
        left.candidate.createdAt.localeCompare(right.candidate.createdAt)
    )
    .map((entry) => entry.candidate);
}

/**
 * The Conversations a Run in `conversationId` draws on, and how many are
 * excluded from it. Self-inclusion is unconditional; everything else is absent
 * when its own flag says so.
 */
function searchableConversations(
  state: AppState,
  conversationId: string
): { included: Set<string>; excludedConversationCount: number } {
  const included = new Set<string>();
  let excludedConversationCount = 0;
  for (const conversation of state.conversations) {
    if (conversation.id === conversationId) continue;
    if (conversation.retrievalExcluded) excludedConversationCount += 1;
    else included.add(conversation.id);
  }
  // Self-inclusion is unconditional: the searching Conversation is in its own
  // Searchable history whatever its own flag says, and whatever the stored
  // records happen to contain.
  included.add(conversationId);
  return { included, excludedConversationCount };
}

/**
 * How many Conversations this Run's Searchable history excludes — the number
 * the result names when it is empty. A Run in an excluded Conversation does
 * not count itself.
 */
export function excludedConversationCount(
  state: AppState,
  conversationId: string
): number {
  return searchableConversations(state, conversationId).excludedConversationCount;
}

/**
 * The History items a Run in `conversationId` may retrieve — **Searchable
 * history**. Self-inclusive and scoped rather than a flat filter: the
 * searching Conversation is in its own whatever its own flag says, and an
 * excluded Conversation is absent from every other one.
 *
 * The membership rule runs before ranking, because it changes `df` for
 * everything that survives it.
 */
export function searchableHistory(
  state: AppState,
  conversationId: string
): HistoryRankItem[] {
  const { included } = searchableConversations(state, conversationId);
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const discussionById = new Map(
    state.discussions.map((discussion) => [discussion.id, discussion])
  );

  return [
    ...state.messages
      // A Discussion's employee Messages carry both `conversationId` and
      // `discussionId`, so a plain Conversation filter would pull Turns into a
      // Searchable history they never cross into. The confirmed Brief is an
      // Artifact and
      // stays in.
      .filter(
        (message) =>
          included.has(message.conversationId) &&
          message.status === "complete" &&
          message.discussionId === undefined
      )
      .map((message) => ({
        id: message.id,
        content: message.content,
        contentFormat: "text" as const,
        createdAt: message.createdAt
      })),
    ...state.tasks
      .filter((task) => included.has(task.conversationId))
      .map((task) => ({
        id: task.id,
        // A Task is a record rather than a document: it stores no prose body,
        // so it contributes the fields that say what it is and where it
        // stands — the same three the result shows for it.
        content: `${task.title}\n${task.goal}\n${task.status}`,
        contentFormat: "text" as const,
        createdAt: task.createdAt
      })),
    ...state.artifacts
      // An Artifact belongs to Searchable history through its owner, a Task
      // or a Discussion — two hops to a Conversation.
      .filter((artifact) => {
        const owner =
          artifact.ownerType === "task"
            ? taskById.get(artifact.ownerId)
            : discussionById.get(artifact.ownerId);
        return owner !== undefined && included.has(owner.conversationId);
      })
      .map((artifact) => ({
        id: artifact.id,
        content: artifact.content,
        contentFormat:
          artifact.type === "json" ? ("json" as const) : ("text" as const),
        createdAt: artifact.createdAt
      }))
  ];
}
