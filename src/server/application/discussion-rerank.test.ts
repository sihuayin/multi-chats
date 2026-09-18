import { describe, expect, it } from "vitest";
import {
  parseRerankOrder,
  rerankChunkOrder
} from "@/server/application/discussion-rerank";
import { rankChunks } from "@/server/application/source-retrieval";
import type { Chunk } from "@/server/domain/types";

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

const chunks = [
  chunk(0, "Weather forecast for the week."),
  chunk(1, "SQLite durability and the persistence model."),
  chunk(2, "A migration strategy for SQLite.")
];
const query = "SQLite migration persistence";

describe("rerankChunkOrder", () => {
  it("reorders the top candidates by the model permutation", async () => {
    const baseline = rankChunks(chunks, query);
    const topIds = baseline.map((item) => item.id);
    const result = await rerankChunkOrder({
      chunks,
      query,
      reorder: async (ids) => [...ids].reverse()
    });

    expect(result.map((item) => item.id)).toEqual([...topIds].reverse());
    expect(new Set(result.map((item) => item.id))).toEqual(
      new Set(chunks.map((item) => item.id))
    );
  });

  it("falls back to the baseline when reorder throws", async () => {
    const result = await rerankChunkOrder({
      chunks,
      query,
      reorder: async () => {
        throw new Error("provider down");
      }
    });
    expect(result.map((item) => item.id)).toEqual(
      rankChunks(chunks, query).map((item) => item.id)
    );
  });

  it("falls back to the baseline on an invalid permutation", async () => {
    const result = await rerankChunkOrder({
      chunks,
      query,
      reorder: async () => ["chunk-1", "chunk-1", "chunk-2"]
    });
    expect(result.map((item) => item.id)).toEqual(
      rankChunks(chunks, query).map((item) => item.id)
    );
  });
});

describe("parseRerankOrder", () => {
  it("parses a valid order from JSON", () => {
    expect(parseRerankOrder('{"order": ["chunk-2", "chunk-1"]}')).toEqual([
      "chunk-2",
      "chunk-1"
    ]);
  });

  it("parses a fenced JSON order", () => {
    expect(
      parseRerankOrder('```json\n{"order": ["chunk-1"]}\n```')
    ).toEqual(["chunk-1"]);
  });

  it("throws on an invalid order", () => {
    expect(() => parseRerankOrder("not json")).toThrow();
    expect(() => parseRerankOrder('{"order": 5}')).toThrow();
  });
});
