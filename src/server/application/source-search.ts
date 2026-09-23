import type { Chunk, Source } from "@/server/domain/types";
import {
  ChunkTokenCache,
  rankChunksCached,
  tokenize
} from "@/server/application/source-retrieval";

/**
 * A product choice, re-justified in #173 rather than inherited: it serves
 * medium-to-large-window models and accepts that a Workspace pointed at a
 * very small window is overwhelmed — which the Conversation transcript alone
 * would do anyway. The cap is not sized against the resolving Employee's
 * model. Counted in code points, not UTF-16 code units, and applied at chunk
 * boundaries: a chunk is returned whole or not at all, so an alias is never
 * copyable next to text the model only partly saw.
 */
export const SEARCH_SOURCES_MAX_RESULT_CODEPOINTS = 40_000;
/** Headroom kept out of the chunk budget so header and footer always fit. */
const RESULT_OVERHEAD_RESERVE_CODEPOINTS = 400;
export const SEARCH_SOURCES_DEFAULT_LIMIT = 5;
export const SEARCH_SOURCES_MAX_LIMIT = 20;

export type SourceSearchRequest = {
  query: string;
  limit?: number;
  sourceId?: string;
};

/** What the ledger records, verbatim, under the tool_completed details guard. */
export type SourceSearchDetails = {
  query: string;
  limit: number;
  returnedChunkIds: string[];
  sourceTitles: string[];
  truncated: boolean;
};

export type SourceSearchOutcome =
  | ({ status: "success"; content: string; searchedChunkCount: number } & SourceSearchDetails)
  | { status: "validation_error"; content: string };

function codePointLength(value: string): number {
  return [...value].length;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return SEARCH_SOURCES_DEFAULT_LIMIT;
  }
  return Math.min(
    SEARCH_SOURCES_MAX_LIMIT,
    Math.max(1, Math.trunc(limit))
  );
}

/**
 * Search every ready, non-tombstoned Source in the Workspace (or the one
 * named `sourceId`) and return citable chunks ranked by the deterministic
 * keyword ranker — `rankChunksCached`, the cached path of the same scoring
 * core `rankChunks` uses, so ordering is identical to the pure ranker.
 *
 * Never leaves the process: it reads the Workspace's own store snapshot and
 * nothing else. Every outcome is non-empty text, because some providers do
 * not tell the model a Tool failed — a failed search says so in its own
 * text, and a search that matched nothing is a normal result, not an error.
 */
export function searchSources(
  corpus: { sources: Source[]; chunks: Chunk[] },
  request: SourceSearchRequest,
  cache: ChunkTokenCache
): SourceSearchOutcome {
  const query = request.query;
  const limit = normalizeLimit(request.limit);

  if (request.sourceId !== undefined) {
    const named = corpus.sources.find(
      (source) => source.id === request.sourceId
    );
    if (!named || named.deletedAt) {
      return {
        status: "validation_error",
        content: `search_sources failed: Source ${request.sourceId} was not found in this Workspace.`
      };
    }
    if (named.status !== "ready") {
      return {
        status: "validation_error",
        content: `search_sources failed: Source ${request.sourceId} is not ready for search (status: ${named.status}). Only ready Sources can be searched.`
      };
    }
  }

  const visibleSources = corpus.sources.filter((source) => !source.deletedAt);
  if (visibleSources.length === 0) {
    return {
      status: "success",
      content:
        "search_sources has nothing to search: this Workspace has no Sources yet. Once documents or pages are ingested as Sources, their content becomes searchable here.",
      query,
      limit,
      returnedChunkIds: [],
      sourceTitles: [],
      truncated: false,
      searchedChunkCount: 0
    };
  }

  const candidateSources = visibleSources.filter(
    (source) =>
      source.status === "ready" &&
      (request.sourceId === undefined || source.id === request.sourceId)
  );
  const sourceTitleById = new Map(
    candidateSources.map((source) => [source.id, source.title])
  );
  const candidates = candidateSources.flatMap((source) =>
    corpus.chunks.filter(
      (chunk) => chunk.sourceId === source.id && !chunk.superseded
    )
  );
  const searchedChunkCount = candidates.length;

  const queryTerms = tokenize(query);
  const matched =
    queryTerms.length === 0
      ? []
      : candidates.filter((chunk) => {
          const { tokenSet } = cache.tokenizationFor(chunk);
          return queryTerms.some((term) => tokenSet.has(term));
        });

  if (matched.length === 0) {
    return {
      status: "success",
      content: [
        `search_sources found no chunks matching the query: "${query}"`,
        `Searched ${searchedChunkCount} current chunks of ${candidateSources.length} ready Sources. Nothing matched — this is a normal result, not a failure; do not retry the same query. Try different wording or a broader query${request.sourceId === undefined ? ", or narrow to one Source with sourceId" : ""}.`
      ].join("\n"),
      query,
      limit,
      returnedChunkIds: [],
      sourceTitles: [],
      truncated: false,
      searchedChunkCount
    };
  }

  const ranked = rankChunksCached(matched, query, cache);

  // Assemble at chunk boundaries: the next chunk either fits whole or the
  // search stops. Slicing the assembled string would cut a chunk mid-text
  // while leaving its alias copyable.
  const chunkBudget =
    SEARCH_SOURCES_MAX_RESULT_CODEPOINTS -
    RESULT_OVERHEAD_RESERVE_CODEPOINTS;
  const blocks: string[] = [];
  const returnedChunkIds: string[] = [];
  let used = 0;
  let returned = 0;
  for (const chunk of ranked) {
    if (returned >= limit) break;
    const title = sourceTitleById.get(chunk.sourceId) ?? "Unknown Source";
    const block = `[external:${chunk.id}]\nSource: ${title}\n${chunk.content}`;
    const blockLength = codePointLength(block) + (blocks.length > 0 ? 2 : 0);
    if (blocks.length > 0 && used + blockLength > chunkBudget) break;
    blocks.push(block);
    used += blockLength;
    returnedChunkIds.push(chunk.id);
    returned += 1;
  }
  // A single first chunk larger than the whole budget still returns whole:
  // the alternative is an empty result, and every result must be non-empty.
  // (Unreachable while chunks are capped at DEFAULT_CHUNK_MAX_CHARS.)
  const truncated = returned < Math.min(limit, ranked.length);

  const sourceTitles = [
    ...new Set(
      returnedChunkIds.map(
        (id) =>
          sourceTitleById.get(
            ranked.find((chunk) => chunk.id === id)?.sourceId ?? ""
          ) ?? "Unknown Source"
      )
    )
  ];

  const header = [
    `search_sources results for query: "${query}"`,
    `Returned ${returned} of ${searchedChunkCount} searched chunks (limit ${limit}).`,
    "Each result below starts with its citation alias on its own line, then the Source title, then the chunk text, returned whole. To cite a chunk, write its alias in square brackets where you use it, for example [external:chunk-id]. Cite only chunks you actually used."
  ].join("\n");
  const footer = truncated
    ? `\n\n${Math.min(limit, ranked.length) - returned} more matching chunks were not returned: the result reached its ${SEARCH_SOURCES_MAX_RESULT_CODEPOINTS}-code-point size limit. Search again with a narrower query or a sourceId if you need them.`
    : "";

  return {
    status: "success",
    content: `${header}\n\n${blocks.join("\n\n")}${footer}`,
    query,
    limit,
    returnedChunkIds,
    sourceTitles,
    truncated,
    searchedChunkCount
  };
}
