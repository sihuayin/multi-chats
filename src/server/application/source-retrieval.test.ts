import { describe, expect, it } from "vitest";
import {
  attachedReadyChunks,
  ChunkTokenCache,
  DEFAULT_CHUNK_TOKEN_CACHE_MAX_ENTRIES,
  discussionRetrievalQuery,
  rankChunks,
  rankChunksCached
} from "@/server/application/source-retrieval";
import { chunkSource } from "@/server/application/source-chunking";
import { createFixtureState } from "@/server/test-support/fixtures";
import type { Chunk, Source } from "@/server/domain/types";

function chunk(index: number, content: string): Chunk {
  return {
    id: `chunk-${index}`,
    workspaceId: "workspace-1",
    sourceId: "source-1",
    index,
    content,
    contentHash: `hash-${index}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("discussionRetrievalQuery", () => {
  it("builds a query from title, note, and questions", () => {
    expect(
      discussionRetrievalQuery({
        title: "Choose a persistence model",
        note: "SQLite is preferred.",
        questions: ["How durable is it?", "What about migrations?"]
      })
    ).toBe(
      "Choose a persistence model SQLite is preferred. How durable is it? What about migrations?"
    );
  });

  it("omits empty note and questions", () => {
    expect(
      discussionRetrievalQuery({ title: "Release scope" })
    ).toBe("Release scope");
  });
});

describe("rankChunks", () => {
  it("ranks chunks that match the query ahead of non-matching chunks", () => {
    const chunks = [
      chunk(0, "Unrelated text about weather."),
      chunk(1, "The persistence model should use SQLite."),
      chunk(2, "Another irrelevant paragraph.")
    ];
    const ranked = rankChunks(chunks, "persistence SQLite");
    expect(ranked[0].index).toBe(1);
  });

  it("is deterministic for identical input", () => {
    const chunks = [
      chunk(0, "Alpha paragraph about SQLite."),
      chunk(1, "Beta paragraph about SQLite durability."),
      chunk(2, "Gamma paragraph about migrations.")
    ];
    const query = "SQLite durability migrations";
    expect(rankChunks(chunks, query).map((item) => item.index)).toEqual(
      rankChunks(chunks, query).map((item) => item.index)
    );
  });

  it("returns chunks in index order when the query is empty", () => {
    const chunks = [chunk(2, "C"), chunk(0, "A"), chunk(1, "B")];
    expect(rankChunks(chunks, "   ").map((item) => item.index)).toEqual([
      0, 1, 2
    ]);
  });

  it("breaks ties by chunk index", () => {
    const chunks = [
      chunk(2, "SQLite is durable."),
      chunk(0, "SQLite is durable."),
      chunk(1, "SQLite is durable.")
    ];
    expect(rankChunks(chunks, "SQLite").map((item) => item.index)).toEqual([
      0, 1, 2
    ]);
  });

  it("ranks a chunk with the query phrase verbatim above a scattered match", () => {
    const chunks = [
      chunk(0, "Persistence, in isolation, is cheap; the data model differs."),
      chunk(1, "The persistence model should use SQLite."),
      chunk(2, "Unrelated text about weather.")
    ];
    const ranked = rankChunks(chunks, "persistence model");
    expect(ranked[0].index).toBe(1);
  });

  it("ranks chunks covering more distinct query terms above those covering fewer", () => {
    const chunks = [
      chunk(0, "Migrations deserve their own section."),
      chunk(1, "SQLite and migrations are covered together."),
      chunk(2, "SQLite durability migrations all together.")
    ];
    const ranked = rankChunks(chunks, "SQLite durability migrations");
    expect(ranked[0].index).toBe(2);
    expect(ranked[1].index).toBe(1);
    expect(ranked[2].index).toBe(0);
  });
});

describe("attachedReadyChunks", () => {
  it("excludes superseded chunks from the current set", () => {
    const state = createFixtureState();
    const source: Source = {
      id: "source-attached",
      workspaceId: state.workspace.id,
      title: "Attached source",
      kind: "file",
      location: "notes.md",
      status: "ready",
      chunkCount: 1,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    };
    state.sources.push(source);
    const chunkBase = {
      workspaceId: state.workspace.id,
      sourceId: source.id,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    };
    state.chunks.push(
      {
        ...chunkBase,
        id: "chunk-old",
        index: 0,
        content: "Old content.",
        contentHash: "hash-old",
        superseded: true
      },
      {
        ...chunkBase,
        id: "chunk-new",
        index: 1,
        content: "New content.",
        contentHash: "hash-new"
      }
    );

    const chunks = attachedReadyChunks(state, { sourceIds: [source.id] });
    expect(chunks.map((chunk) => chunk.id)).toEqual(["chunk-new"]);
  });
});


describe("rankChunksCached", () => {
  it("returns exactly what the pure ranker returns, in the same order, for every case", () => {
    const chunks = [
      chunk(0, "Unrelated text about weather."),
      chunk(1, "The persistence model should use SQLite."),
      chunk(2, "Persistence, in isolation, is cheap; the data model differs."),
      chunk(3, "SQLite durability migrations all together."),
      chunk(4, "Migrations deserve their own section.")
    ];
    const cache = new ChunkTokenCache();
    for (const query of [
      "persistence model",
      "SQLite durability migrations",
      "weather",
      "   ",
      "a query that matches nothing at all"
    ]) {
      expect(
        rankChunksCached(chunks, query, cache).map((item) => item.id)
      ).toEqual(rankChunks(chunks, query).map((item) => item.id));
    }
  });

  it("does not tokenize unchanged content again on a second search", () => {
    const chunks = [
      chunk(0, "The persistence model should use SQLite."),
      chunk(1, "Migrations deserve their own section."),
      chunk(2, "Unrelated text about weather.")
    ];
    const cache = new ChunkTokenCache();

    const first = rankChunksCached(chunks, "persistence SQLite", cache);
    expect(cache.tokenizationCount).toBe(3);
    const second = rankChunksCached(chunks, "migrations weather", cache);
    expect(cache.tokenizationCount).toBe(3);
    expect(cache.size).toBe(3);
    expect(second.map((item) => item.id)).toEqual(
      rankChunks(chunks, "migrations weather").map((item) => item.id)
    );
    expect(first.map((item) => item.id)).toEqual(
      rankChunks(chunks, "persistence SQLite").map((item) => item.id)
    );
  });

  it("shares one entry between chunks with identical content", () => {
    const content = "SQLite is durable.";
    const a: Chunk = { ...chunk(0, content), id: "chunk-a", contentHash: "hash-shared" };
    const b: Chunk = { ...chunk(1, content), id: "chunk-b", contentHash: "hash-shared" };
    const cache = new ChunkTokenCache();

    rankChunksCached([a, b], "SQLite", cache);
    expect(cache.size).toBe(1);
    expect(cache.tokenizationCount).toBe(1);
  });

  it("never serves changed content from a stale entry", () => {
    // A refresh appends new chunks under new content hashes; ids derive from
    // the hash, so a content change is always a cache miss.
    const revisions = chunkSource({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      text: "SQLite durability is the selling point.\n\nWeather reports follow.",
      now: "2026-01-01T00:00:00.000Z"
    });
    const cache = new ChunkTokenCache();

    const before = rankChunksCached(revisions, "SQLite durability", cache);
    const countBefore = cache.tokenizationCount;

    const refreshed = chunkSource({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      text: "Weather reports only, nothing else.\n\nMore weather coverage.",
      now: "2026-01-02T00:00:00.000Z"
    });
    // Same source, new revision: every id/hash differs from the old set.
    expect(
      refreshed.every((item) =>
        revisions.every((old) => old.contentHash !== item.contentHash)
      )
    ).toBe(true);

    const after = rankChunksCached(refreshed, "weather", cache);
    expect(cache.tokenizationCount).toBe(countBefore + refreshed.length);
    expect(after[0].content).toContain("Weather");
    expect(before[0].content).toContain("SQLite");
  });

  it("stays within its bound across many searches", () => {
    const cache = new ChunkTokenCache(3);
    const chunks = Array.from({ length: 10 }, (_, index) =>
      chunk(index, `Paragraph number ${index} about topic-${index} SQLite.`)
    );

    for (let search = 0; search < 5; search += 1) {
      rankChunksCached(chunks, `topic-${search % 10}`, cache);
      expect(cache.size).toBeLessThanOrEqual(3);
    }
    expect(cache.tokenizationCount).toBe(50);

    // A bound that fits the corpus keeps every entry warm.
    const roomy = new ChunkTokenCache();
    rankChunksCached(chunks, "SQLite", roomy);
    rankChunksCached(chunks, "topic-4", roomy);
    expect(roomy.size).toBe(10);
    expect(roomy.tokenizationCount).toBe(10);
  });

  it("has a default bound settled as a positive finite number", () => {
    expect(DEFAULT_CHUNK_TOKEN_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_CHUNK_TOKEN_CACHE_MAX_ENTRIES)).toBe(true);
  });
});
