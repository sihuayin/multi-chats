import { describe, expect, it } from "vitest";
import {
  chunkId,
  chunkSource,
  contentHash,
  splitText
} from "@/server/application/source-chunking";

describe("contentHash", () => {
  it("is stable for identical input and distinct for different input", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });
});

describe("splitText", () => {
  it("splits on blank-line paragraph boundaries", () => {
    const chunks = splitText("First paragraph.\n\nSecond paragraph.");
    expect(chunks).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("splits before Markdown headings", () => {
    const chunks = splitText("Intro text.\n\n# Heading\n\nBody under heading.");
    expect(chunks[0]).toBe("Intro text.");
    expect(chunks[1]).toContain("# Heading");
  });

  it("caps oversized blocks at the configured character limit", () => {
    const text = "x".repeat(30);
    const chunks = splitText(text, 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(10)]);
  });

  it("is deterministic for the same input", () => {
    const input = "# A\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.";
    expect(splitText(input)).toEqual(splitText(input));
  });

  it("returns an empty list for whitespace-only input", () => {
    expect(splitText("   \n\n  ")).toEqual([]);
  });
});

describe("chunkSource", () => {
  it("produces reproducible chunk ids and content hashes", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const first = chunkSource({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      text: "One.\n\nTwo.",
      now
    });
    const second = chunkSource({
      sourceId: "source-1",
      workspaceId: "workspace-1",
      text: "One.\n\nTwo.",
      now
    });
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(first[0].contentHash).toBe(contentHash(first[0].content));
    expect(first[0].id).toBe(
      chunkId("source-1", 0, contentHash("One."))
    );
  });

  it("scopes chunk ids to the source", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const a = chunkSource({
      sourceId: "source-a",
      workspaceId: "workspace-1",
      text: "Shared text.",
      now
    });
    const b = chunkSource({
      sourceId: "source-b",
      workspaceId: "workspace-1",
      text: "Shared text.",
      now
    });
    expect(a[0].id).not.toBe(b[0].id);
  });
});
