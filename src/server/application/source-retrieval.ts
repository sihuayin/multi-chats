import type { AppState, Chunk } from "@/server/domain/types";

function tokenize(value: string): string[] {
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
        source.status === "ready"
    )
    .flatMap((source) =>
      state.chunks.filter((chunk) => chunk.sourceId === source.id)
    );
}

/**
 * Deterministic keyword ranking: score each chunk by the inverse-document
 * frequency of the query terms it contains, then break ties by chunk index.
 * No embeddings or vector dependency; identical input always yields the same
 * ordering.
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
    return { chunk, tokenSet: new Set(tokens) };
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
    .map(({ chunk, tokenSet }) => {
      let score = 0;
      for (const term of queryTerms) {
        if (!tokenSet.has(term)) continue;
        const frequency = documentFrequency.get(term) ?? documentCount;
        score += Math.log(1 + documentCount / Math.max(1, frequency));
      }
      return { chunk, score };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.chunk.index - right.chunk.index
    )
    .map((item) => item.chunk);
}
