import type { IsoDate } from "@/server/domain/types";
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
