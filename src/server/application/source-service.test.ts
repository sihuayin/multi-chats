import { describe, expect, it } from "vitest";
import { SourceService } from "@/server/application/source-service";
import type {
  SourceTextInput,
  TextExtractor
} from "@/server/application/text-extractor";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureDiscussion,
  createFixtureState
} from "@/server/test-support/fixtures";

function storeWithExtractor(extractor: TextExtractor) {
  const store = new MemoryStore(createFixtureState());
  const service = new SourceService(store, extractor);
  return { store, service };
}

const textExtractor: TextExtractor = {
  async extract(input: SourceTextInput) {
    if (input.kind === "url") {
      if (input.location.includes("unreachable")) {
        throw new Error("URL is unreachable");
      }
      return "Fetched heading\n\nFetched paragraph body.";
    }
    if (!input.content.trim()) {
      throw new Error("Source produced no readable text");
    }
    return input.content;
  }
};

describe("SourceService", () => {
  it("creates a text file Source that reaches ready with deterministic chunks", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const source = await service.createSource({
      kind: "file",
      location: "notes.md",
      content: "First paragraph.\n\nSecond paragraph."
    });
    expect(source.status).toBe("ready");
    expect(source.chunkCount).toBe(2);
    expect(source.contentHash).toBeDefined();
    const chunks = await service.listChunks(source.id);
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "First paragraph.",
      "Second paragraph."
    ]);
    // pendingContent must not be exposed after successful ingestion
    expect("pendingContent" in source).toBe(false);
  });

  it("creates a URL Source as pending, then ingests it to ready", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/article"
    });
    expect(created.status).toBe("pending");

    const ingested = await service.ingestPendingSources();
    expect(ingested).toBe(1);

    const ready = await service.getSource(created.id);
    expect(ready.status).toBe("ready");
    expect(ready.chunkCount).toBe(2);
    expect((await service.listChunks(created.id))[0].content).toBe(
      "Fetched heading"
    );
  });

  it("marks an unreachable URL Source as failed with a clear error", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/unreachable"
    });
    await service.ingestPendingSources();
    const failed = await service.getSource(created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("URL is unreachable");
  });

  it("retries a failed Source and re-ingests it", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/unreachable"
    });
    await service.ingestPendingSources();
    expect((await service.getSource(created.id)).status).toBe("failed");

    const retried = await service.retrySource(created.id);
    expect(retried.status).toBe("failed");
  });

  it("retries a failed Source that later succeeds", async () => {
    let fail = true;
    const flaky: TextExtractor = {
      async extract(input: SourceTextInput) {
        if (input.kind === "url" && fail) throw new Error("temporary");
        return "Recovered text.";
      }
    };
    const { service } = storeWithExtractor(flaky);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/flaky"
    });
    await service.ingestPendingSources();
    expect((await service.getSource(created.id)).status).toBe("failed");

    fail = false;
    const retried = await service.retrySource(created.id);
    expect(retried.status).toBe("ready");
    expect(retried.chunkCount).toBe(1);
  });

  it("deletes a Source and its chunks, leaving no orphans", async () => {
    const { store, service } = storeWithExtractor(textExtractor);
    const source = await service.createSource({
      kind: "file",
      location: "notes.md",
      content: "One.\n\nTwo."
    });
    expect(source.chunkCount).toBe(2);

    await service.deleteSource(source.id);
    const state = store.snapshot();
    expect(state.sources).toHaveLength(0);
    expect(state.chunks).toHaveLength(0);
  });

  it("removes a deleted Source from Discussion sourceIds", async () => {
    const { store, service } = storeWithExtractor(textExtractor);
    const source = await service.createSource({
      kind: "file",
      location: "notes.md",
      content: "One."
    });
    await store.update((state) => {
      state.discussions.push({
        ...createFixtureDiscussion(),
        sourceIds: [source.id]
      });
    });

    await service.deleteSource(source.id);
    const discussion = store.snapshot().discussions[0];
    expect(discussion.sourceIds).toEqual([]);
  });

  it("rejects a file Source with empty content", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const source = await service.createSource({
      kind: "file",
      location: "empty.md",
      content: "   "
    });
    expect(source.status).toBe("failed");
    expect(source.error).toBeDefined();
  });

  it("rejects retrying a Source that is not failed", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const source = await service.createSource({
      kind: "file",
      location: "notes.md",
      content: "One."
    });
    expect(source.status).toBe("ready");

    await expect(service.retrySource(source.id)).rejects.toThrow(
      "Only failed Sources can be retried"
    );
  });

  it("ingests a PDF Source to ready with chunked text", async () => {
    const pdfExtractor: TextExtractor = {
      async extract(input: SourceTextInput) {
        if (input.kind === "file") {
          return input.location.endsWith(".pdf")
            ? "PDF heading\n\nPDF body."
            : input.content;
        }
        return "";
      }
    };
    const { service } = storeWithExtractor(pdfExtractor);
    const source = await service.createSource({
      kind: "file",
      location: "report.pdf",
      content: "base64-pdf-bytes"
    });
    expect(source.status).toBe("ready");
    expect(source.chunkCount).toBe(2);
    const chunks = await service.listChunks(source.id);
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "PDF heading",
      "PDF body."
    ]);
  });

  it("marks a malformed or image-only PDF as failed", async () => {
    const failingPdf: TextExtractor = {
      async extract(input: SourceTextInput) {
        if (input.kind === "file" && input.location.endsWith(".pdf")) {
          throw new Error("PDF produced no readable text");
        }
        return input.kind === "file" ? input.content : "";
      }
    };
    const { service } = storeWithExtractor(failingPdf);
    const source = await service.createSource({
      kind: "file",
      location: "image-only.pdf",
      content: "base64-pdf-bytes"
    });
    expect(source.status).toBe("failed");
    expect(source.error).toContain("PDF");
  });
});

describe("refreshSource", () => {
  it("supersedes old chunks and appends a new set on changed content", async () => {
    let fetched = "Version one.\n\nBody one.";
    const changing: TextExtractor = {
      async extract(input: SourceTextInput) {
        if (input.kind === "url") return fetched;
        return input.content ?? "";
      }
    };
    const { store, service } = storeWithExtractor(changing);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/article"
    });
    await service.ingestPendingSources();
    const before = await service.getSource(created.id);
    expect(before.chunkCount).toBe(2);
    const oldChunkIds = (await service.listChunks(created.id)).map(
      (chunk) => chunk.id
    );

    fetched = "Version two.\n\nBody two.\n\nBody three.";
    const refreshed = await service.refreshSource(created.id);
    expect(refreshed.chunkCount).toBe(3);
    expect(refreshed.contentHash).not.toBe(before.contentHash);

    const chunks = store.snapshot().chunks.filter(
      (chunk) => chunk.sourceId === created.id
    );
    expect(chunks.filter((chunk) => chunk.superseded)).toHaveLength(2);
    expect(chunks.filter((chunk) => !chunk.superseded)).toHaveLength(3);
    for (const id of oldChunkIds) {
      expect(chunks.some((chunk) => chunk.id === id)).toBe(true);
    }
  });

  it("leaves a Source unchanged when refreshed content is identical", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/article"
    });
    await service.ingestPendingSources();
    const before = await service.getSource(created.id);

    const refreshed = await service.refreshSource(created.id);
    expect(refreshed.contentHash).toBe(before.contentHash);
    expect(refreshed.chunkCount).toBe(before.chunkCount);
    expect(await service.listChunks(created.id)).toHaveLength(before.chunkCount);
  });

  it("keeps the current set when a refresh fetch fails", async () => {
    let fail = false;
    const flaky: TextExtractor = {
      async extract(input: SourceTextInput) {
        if (input.kind === "url") {
          if (fail) throw new Error("network down");
          return "Stable text.";
        }
        return input.content ?? "";
      }
    };
    const { service } = storeWithExtractor(flaky);
    const created = await service.createSource({
      kind: "url",
      location: "https://example.com/article"
    });
    await service.ingestPendingSources();
    const before = await service.getSource(created.id);
    expect(before.status).toBe("ready");

    fail = true;
    await expect(service.refreshSource(created.id)).rejects.toThrow(
      "network down"
    );
    const after = await service.getSource(created.id);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.chunkCount).toBe(before.chunkCount);
  });

  it("rejects refreshing a file Source", async () => {
    const { service } = storeWithExtractor(textExtractor);
    const source = await service.createSource({
      kind: "file",
      location: "notes.md",
      content: "One."
    });
    await expect(service.refreshSource(source.id)).rejects.toThrow(
      "Only URL Sources can be refreshed"
    );
  });
});
