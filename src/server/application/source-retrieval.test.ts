import { describe, expect, it } from "vitest";
import {
  discussionRetrievalQuery,
  rankChunks
} from "@/server/application/source-retrieval";
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
});
