import { describe, expect, it } from "vitest";
import {
  SEARCH_SOURCES_DEFAULT_LIMIT,
  SEARCH_SOURCES_MAX_LIMIT,
  SEARCH_SOURCES_MAX_RESULT_CODEPOINTS,
  searchSources
} from "@/server/application/source-search";
import {
  ChunkTokenCache,
  rankChunks
} from "@/server/application/source-retrieval";
import { chunkSource } from "@/server/application/source-chunking";
import type { Chunk, Source } from "@/server/domain/types";

const NOW = "2026-01-01T00:00:00.000Z";

function source(
  id: string,
  title: string,
  overrides: Partial<Source> = {}
): Source {
  return {
    id,
    workspaceId: "workspace-1",
    title,
    kind: "file",
    location: `${id}.md`,
    status: "ready",
    chunkCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function chunksFor(
  sourceId: string,
  text: string,
  overrides: Partial<Chunk> = {}
): Chunk[] {
  return chunkSource({
    sourceId,
    workspaceId: "workspace-1",
    text,
    now: NOW
  }).map((chunk) => ({ ...chunk, ...overrides }));
}

function corpus(
  sources: Source[],
  chunks: Chunk[]
): { sources: Source[]; chunks: Chunk[] } {
  return { sources, chunks };
}

describe("searchSources", () => {
  it("returns matching chunks whole, each with its alias beside the text, and a self-describing header", () => {
    const state = corpus(
      [source("source-notes", "Field notes"), source("source-other", "Other")],
      [
        ...chunksFor(
          "source-notes",
          "SQLite durability is the selling point.\n\nWeather reports follow."
        ),
        ...chunksFor("source-other", "Unrelated cooking notes about flour.")
      ]
    );
    const outcome = searchSources(
      state,
      { query: "SQLite durability" },
      new ChunkTokenCache()
    );

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    // Header names the query, the returned count, the candidate-set size,
    // and how to cite.
    expect(outcome.content).toContain(
      'search_sources results for query: "SQLite durability"'
    );
    expect(outcome.content).toContain("Returned 1 of 3 searched chunks");
    expect(outcome.content).toContain(
      "write its alias in square brackets"
    );
    // Every returned chunk is whole, alias on its own line, Source title next.
    const chunk = state.chunks[0];
    expect(outcome.content).toContain(`[external:${chunk.id}]\nSource: Field notes\nSQLite durability is the selling point.`);
    expect(outcome.returnedChunkIds).toEqual([chunk.id]);
    expect(outcome.sourceTitles).toEqual(["Field notes"]);
    expect(outcome.truncated).toBe(false);
    expect(outcome.query).toBe("SQLite durability");
    expect(outcome.limit).toBe(SEARCH_SOURCES_DEFAULT_LIMIT);
  });

  it("orders results exactly like the pure ranker over the matched candidates", () => {
    const chunks = [
      ...chunksFor("source-1", "Migrations deserve their own section."),
      ...chunksFor("source-1", "SQLite and migrations are covered together."),
      ...chunksFor("source-1", "SQLite durability migrations all together."),
      ...chunksFor("source-1", "Unrelated text about weather.")
    ];
    const state = corpus([source("source-1", "Notes")], chunks);
    const query = "SQLite durability migrations";
    const outcome = searchSources(
      state,
      { query, limit: 10 },
      new ChunkTokenCache()
    );
    if (outcome.status !== "success") throw new Error("expected success");

    const matched = chunks.filter((chunk) => chunk.content !== "Unrelated text about weather.");
    expect(outcome.returnedChunkIds).toEqual(
      rankChunks(matched, query).map((chunk) => chunk.id)
    );
  });

  it("never returns chunks of deleted or ingesting Sources, nor superseded chunks", () => {
    const state = corpus(
      [
        source("ready", "Ready"),
        source("deleted", "Deleted", { deletedAt: NOW }),
        source("ingesting", "Ingesting", { status: "ingesting" })
      ],
      [
        ...chunksFor("ready", "SQLite durability, current revision.", {
          superseded: true
        }),
        ...chunksFor("ready", "SQLite durability, current text."),
        ...chunksFor("deleted", "SQLite durability behind a tombstone."),
        ...chunksFor("ingesting", "SQLite durability still extracting.")
      ]
    );
    const outcome = searchSources(
      state,
      { query: "durability" },
      new ChunkTokenCache()
    );
    if (outcome.status !== "success") throw new Error("expected success");

    expect(outcome.returnedChunkIds).toHaveLength(1);
    expect(outcome.content).toContain("current text");
    expect(outcome.content).not.toContain("tombstone");
    expect(outcome.content).not.toContain("still extracting");
    expect(outcome.content).not.toContain("current revision");
    expect(outcome.searchedChunkCount).toBe(1);
  });

  it("narrows to one Source when sourceId is named, and counts only that Source", () => {
    const state = corpus(
      [source("source-a", "Alpha"), source("source-b", "Beta")],
      [
        ...chunksFor("source-a", "Persistence model notes for alpha."),
        ...chunksFor("source-b", "Persistence model notes for beta.")
      ]
    );
    const outcome = searchSources(
      state,
      { query: "persistence model", sourceId: "source-b" },
      new ChunkTokenCache()
    );
    if (outcome.status !== "success") throw new Error("expected success");

    expect(outcome.searchedChunkCount).toBe(1);
    expect(outcome.returnedChunkIds).toEqual([
      state.chunks.find((chunk) => chunk.sourceId === "source-b")!.id
    ]);
    expect(outcome.sourceTitles).toEqual(["Beta"]);
  });

  it("reports an unknown or tombstoned sourceId as a validation error naming it", () => {
    const state = corpus(
      [source("gone", "Gone", { deletedAt: NOW })],
      chunksFor("gone", "SQLite durability.")
    );
    const cache = new ChunkTokenCache();

    const missing = searchSources(
      state,
      { query: "durability", sourceId: "no-such-source" },
      cache
    );
    expect(missing.status).toBe("validation_error");
    expect(missing.content).toContain("no-such-source");
    expect(missing.content).toContain("not found");

    const tombstoned = searchSources(
      state,
      { query: "durability", sourceId: "gone" },
      cache
    );
    expect(tombstoned.status).toBe("validation_error");
    expect(tombstoned.content).toContain("gone");
    expect(tombstoned.content).toContain("not found");
  });

  it("reports a non-ready sourceId as a validation error stating the status", () => {
    const state = corpus(
      [source("busy", "Busy", { status: "ingesting" })],
      []
    );
    const outcome = searchSources(
      state,
      { query: "anything", sourceId: "busy" },
      new ChunkTokenCache()
    );
    expect(outcome.status).toBe("validation_error");
    expect(outcome.content).toContain("busy");
    expect(outcome.content).toContain("ingesting");
    expect(outcome.content).toContain("not ready");
  });

  it("treats zero matches as a normal, non-empty result, not an error", () => {
    const state = corpus(
      [source("source-1", "Notes")],
      chunksFor("source-1", "SQLite durability notes.")
    );
    const outcome = searchSources(
      state,
      { query: "blockchain synergies" },
      new ChunkTokenCache()
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.content.length).toBeGreaterThan(0);
    expect(outcome.content).toContain("no chunks matching");
    expect(outcome.content).toContain("not a failure");
    expect(outcome.returnedChunkIds).toEqual([]);
    expect(outcome.searchedChunkCount).toBe(1);
  });

  it("tells the model a Workspace with no Sources has nothing to search", () => {
    const outcome = searchSources(
      corpus([], []),
      { query: "anything" },
      new ChunkTokenCache()
    );
    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.content.length).toBeGreaterThan(0);
    expect(outcome.content).toContain("no Sources yet");
    expect(outcome.searchedChunkCount).toBe(0);
  });

  it("clamps the limit into [1, 20] with a default of 5", () => {
    const chunks = Array.from({ length: 25 }, (_, index) =>
      chunksFor(
        "source-1",
        `Persistence note number ${index} stands alone in its own chunk body.`
      )[0]
    );
    const state = corpus([source("source-1", "Notes")], chunks);

    const wide = searchSources(
      state,
      { query: "persistence", limit: 99 },
      new ChunkTokenCache()
    );
    if (wide.status !== "success") throw new Error("expected success");
    expect(wide.limit).toBe(SEARCH_SOURCES_MAX_LIMIT);
    expect(wide.returnedChunkIds).toHaveLength(SEARCH_SOURCES_MAX_LIMIT);

    const zero = searchSources(
      state,
      { query: "persistence", limit: 0 },
      new ChunkTokenCache()
    );
    if (zero.status !== "success") throw new Error("expected success");
    expect(zero.limit).toBe(1);
    expect(zero.returnedChunkIds).toHaveLength(1);
  });

  it("cuts an oversized result at a chunk boundary and counts the dropped chunks without naming them", () => {
    // 20 maximum-length chunks that all match: the assembled result cannot
    // hold them within the cap, so it must stop at a chunk boundary and say
    // how many it did not return — never which ones.
    const chunks = Array.from({ length: SEARCH_SOURCES_MAX_LIMIT }, (_, index) =>
      chunksFor(
        "source-1",
        `durability `.repeat(360) + `variant${index}`
      )[0]
    );
    const state = corpus([source("source-1", "Notes")], chunks);

    const outcome = searchSources(
      state,
      { query: "durability", limit: SEARCH_SOURCES_MAX_LIMIT },
      new ChunkTokenCache()
    );
    if (outcome.status !== "success") throw new Error("expected success");

    expect(outcome.truncated).toBe(true);
    const codePoints = [...outcome.content].length;
    expect(codePoints).toBeLessThanOrEqual(SEARCH_SOURCES_MAX_RESULT_CODEPOINTS);
    // Every returned chunk is whole: its full content appears verbatim.
    for (const id of outcome.returnedChunkIds) {
      const chunk = chunks.find((item) => item.id === id)!;
      expect(outcome.content).toContain(chunk.content);
    }
    // The footer counts the dropped chunks and does not name them.
    const dropped = chunks.filter(
      (chunk) => !outcome.returnedChunkIds.includes(chunk.id)
    );
    expect(dropped.length).toBeGreaterThan(0);
    expect(outcome.content).toContain(
      `${dropped.length} more matching chunks were not returned`
    );
    for (const chunk of dropped) {
      expect(outcome.content).not.toContain(`[external:${chunk.id}]`);
      expect(outcome.content).not.toContain(chunk.content);
    }
  });

  it("counts the cap in code points, so astral text is never cut mid-surrogate", () => {
    // Each emoji is one code point but two UTF-16 code units; a cap counted
    // in code units would slice pairs. Chunks stay whole by construction,
    // and the assembled result must contain no unpaired surrogate.
    // Each emoji is two UTF-16 code units but one code point: 1,990 of them
    // fill a chunk to ~3,991 code units (~2,002 code points), so 20 chunks
    // exceed the code-point cap while every chunk stays whole.
    const emoji = "🙂";
    const chunks = Array.from({ length: SEARCH_SOURCES_MAX_LIMIT }, (_, index) =>
      chunksFor(
        "source-1",
        `durability ${emoji.repeat(1_990)} t${index}`
      )[0]
    );
    const state = corpus([source("source-1", "Notes")], chunks);

    const outcome = searchSources(
      state,
      { query: "durability", limit: SEARCH_SOURCES_MAX_LIMIT },
      new ChunkTokenCache()
    );
    if (outcome.status !== "success") throw new Error("expected success");

    expect(outcome.truncated).toBe(true);
    expect([...outcome.content].length).toBeLessThanOrEqual(
      SEARCH_SOURCES_MAX_RESULT_CODEPOINTS
    );
    const unpairedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(unpairedSurrogate.test(outcome.content)).toBe(false);
  });

  it("does not tokenize unchanged content again on a second search", () => {
    const state = corpus(
      [source("source-1", "Notes")],
      chunksFor("source-1", "SQLite durability notes.\n\nMigrations matter too.")
    );
    const cache = new ChunkTokenCache();

    const first = searchSources(state, { query: "durability" }, cache);
    const afterFirst = cache.tokenizationCount;
    const second = searchSources(state, { query: "migrations" }, cache);

    expect(afterFirst).toBe(2);
    expect(cache.tokenizationCount).toBe(2);
    expect(second.status).toBe("success");
    expect(first.status).toBe("success");
  });
});
