import type { AppState, Chunk } from "@/server/domain/types";

/** Shared with the sibling history ranker, which tokenises the same way. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * The retrieval query for a Discussion is built from the user's framing — the
 * title, note, and questions — never from a live model turn.
 */
export function discussionRetrievalQuery(discussion: {
  title: string;
  note?: string;
  questions?: string[];
}): string {
  return [discussion.title, discussion.note, ...(discussion.questions ?? [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
}

/**
 * The chunks of every `ready` Source attached to a Discussion, in source order
 * then chunk index order. This is the single traversal for "attached Sources →
 * chunks" shared by evidence catalog and context injection.
 */
export function attachedReadyChunks(
  state: AppState,
  discussion: { sourceIds: string[] }
): Chunk[] {
  return state.sources
    .filter(
      (source) =>
        discussion.sourceIds.includes(source.id) &&
        source.status === "ready" &&
        !source.deletedAt
    )
    .flatMap((source) =>
      state.chunks.filter(
        (chunk) => chunk.sourceId === source.id && !chunk.superseded
      )
    );
}

/**
 * The longest contiguous run of query terms (in query order) that appears
 * consecutively in `tokens`. Returns 0 for no match, 1 for an isolated term,
 * and ≥2 only when two or more query terms sit adjacent in the chunk — the
 * exact-phrase signal that separates "the persistence model" from
 * "persistence … model".
 *
 * Shared with the sibling history ranker, which boosts the same way.
 */
export function longestPhraseMatch(
  tokens: string[],
  queryTerms: string[]
): number {
  const startsByTerm = new Map<string, number[]>();
  queryTerms.forEach((term, index) => {
    const starts = startsByTerm.get(term) ?? [];
    starts.push(index);
    startsByTerm.set(term, starts);
  });
  let best = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const starts = startsByTerm.get(tokens[i]);
    if (!starts) continue;
    for (const start of starts) {
      let length = 1;
      let cursor = i + 1;
      let next = start + 1;
      while (
        cursor < tokens.length &&
        next < queryTerms.length &&
        tokens[cursor] === queryTerms[next]
      ) {
        length += 1;
        cursor += 1;
        next += 1;
      }
      if (length > best) best = length;
    }
  }
  return best;
}

/**
 * Deterministic keyword ranking: score each chunk by the inverse-document
 * frequency of the query terms it contains, add an exact-phrase boost when a
 * contiguous multi-term query subphrase appears verbatim, then break ties by
 * term coverage and finally chunk index. No embeddings or vector dependency;
 * identical input always yields the same ordering.
 */
export function rankChunks(chunks: Chunk[], query: string): Chunk[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return chunks
      .slice()
      .sort((left, right) => left.index - right.index);
  }

  const tokenized = chunks.map((chunk) => {
    const tokens = tokenize(chunk.content);
    return { chunk, tokens, tokenSet: new Set(tokens) };
  });
  const documentCount = Math.max(1, tokenized.length);
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      tokenized.filter((item) => item.tokenSet.has(term)).length
    );
  }

  return tokenized
    .map(({ chunk, tokens, tokenSet }) => {
      let score = 0;
      let coverage = 0;
      for (const term of queryTerms) {
        if (!tokenSet.has(term)) continue;
        coverage += 1;
        const frequency = documentFrequency.get(term) ?? documentCount;
        score += Math.log(1 + documentCount / Math.max(1, frequency));
      }
      const phrase = longestPhraseMatch(tokens, queryTerms);
      if (phrase >= 2) score += phrase;
      return { chunk, score, coverage };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.coverage - left.coverage ||
        left.chunk.index - right.chunk.index
    )
    .map((item) => item.chunk);
}
