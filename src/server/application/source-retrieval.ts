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

type PreparedChunk = {
  chunk: Chunk;
  tokens: string[];
  tokenSet: Set<string>;
};

function byIndexOrder(prepared: PreparedChunk[]): Chunk[] {
  return prepared
    .map((item) => item.chunk)
    .slice()
    .sort((left, right) => left.index - right.index);
}

/** The scoring core shared by the pure ranker and the cached wrapper. */
function rankPreparedChunks(
  prepared: PreparedChunk[],
  queryTerms: string[]
): Chunk[] {
  const documentCount = Math.max(1, prepared.length);
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      prepared.filter((item) => item.tokenSet.has(term)).length
    );
  }

  return prepared
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

function prepareChunk(chunk: Chunk): PreparedChunk {
  const tokens = tokenize(chunk.content);
  return { chunk, tokens, tokenSet: new Set(tokens) };
}

/**
 * Deterministic keyword ranking: score each chunk by the inverse-document
 * frequency of the query terms it contains, add an exact-phrase boost when a
 * contiguous multi-term query subphrase appears verbatim, then break ties by
 * term coverage and finally chunk index. No embeddings or vector dependency;
 * identical input always yields the same ordering.
 *
 * Pure: callable with an array and a query, depending on nothing else, so it
 * stays directly assertable. Search paths that call it repeatedly over an
 * unchanged corpus should go through `rankChunksCached` instead.
 */
export function rankChunks(chunks: Chunk[], query: string): Chunk[] {
  const queryTerms = tokenize(query);
  const prepared = chunks.map(prepareChunk);
  if (queryTerms.length === 0) {
    return byIndexOrder(prepared);
  }
  return rankPreparedChunks(prepared, queryTerms);
}

/**
 * Settled by measurement, not taste: a maximum-length chunk (4,000 chars)
 * costs up to ~40 KB of heap per cached tokenization in the worst case
 * (every token unique), so 1,000 entries cap the cache at roughly 40 MB and
 * typical prose corpora far less. Full coverage of the 5,000-chunk reference
 * corpus measured ~191 MB — rejected for an interactive server. A corpus
 * whose working set exceeds the bound re-tokenizes on each search, which is
 * the corpus-size revision trigger the diagnostics surface exposes, not a
 * defect to paper over with a bigger bound.
 */
export const DEFAULT_CHUNK_TOKEN_CACHE_MAX_ENTRIES = 1_000;

export type ChunkTokenization = {
  tokens: string[];
  tokenSet: Set<string>;
};

/**
 * Bounded LRU cache of chunk tokenizations keyed by `contentHash`. Owned by
 * the execution path that searches repeatedly (the Tool path), never a
 * module global, so its lifetime and bound are the caller's decision.
 *
 * Keying by `contentHash` is correct by construction because chunk text is
 * immutable: a refresh appends new chunks under new hashes and flags the old
 * ones superseded, so identical content shares one entry and changed content
 * can never be served from a stale entry.
 */
export class ChunkTokenCache {
  private readonly entries = new Map<string, ChunkTokenization>();
  private tokenizations = 0;

  constructor(
    private readonly maxEntries: number = DEFAULT_CHUNK_TOKEN_CACHE_MAX_ENTRIES
  ) {}

  tokenizationFor(chunk: Chunk): ChunkTokenization {
    const cached = this.entries.get(chunk.contentHash);
    if (cached) {
      // LRU touch: reinsert so the oldest entry is the least recently used.
      this.entries.delete(chunk.contentHash);
      this.entries.set(chunk.contentHash, cached);
      return cached;
    }
    const entry = prepareTokenization(chunk);
    this.tokenizations += 1;
    this.entries.set(chunk.contentHash, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }

  /** How many tokenizations this cache actually performed (hits excluded). */
  get tokenizationCount(): number {
    return this.tokenizations;
  }
}

function prepareTokenization(chunk: Chunk): ChunkTokenization {
  const tokens = tokenize(chunk.content);
  return { tokens, tokenSet: new Set(tokens) };
}

/**
 * `rankChunks` without re-reading content it has already tokenized: returns
 * exactly what the pure ranker returns, in the same order, for every case —
 * both delegate to one scoring core — but sources per-chunk tokenizations
 * from the caller-owned bounded cache.
 */
export function rankChunksCached(
  chunks: Chunk[],
  query: string,
  cache: ChunkTokenCache
): Chunk[] {
  const queryTerms = tokenize(query);
  const prepared = chunks.map((chunk) => ({
    chunk,
    ...cache.tokenizationFor(chunk)
  }));
  if (queryTerms.length === 0) {
    return byIndexOrder(prepared);
  }
  return rankPreparedChunks(prepared, queryTerms);
}
