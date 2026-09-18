import { describe, expect, it } from "vitest";
import {
  attachedReadyChunks,
  discussionRetrievalQuery,
  rankChunks
} from "@/server/application/source-retrieval";
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
