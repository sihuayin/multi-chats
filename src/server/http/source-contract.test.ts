import { afterEach, describe, expect, it } from "vitest";
import {
  getServices,
  setServicesForTests
} from "@/server/application/services";
import { SourceService } from "@/server/application/source-service";
import type {
  SourceTextInput,
  TextExtractor
} from "@/server/application/text-extractor";
import { handleApiRequest } from "@/server/http/router";
import { setStoreForTests } from "@/server/store";
import { MemoryStore } from "@/server/store/memory-store";
import { createFixtureState } from "@/server/test-support/fixtures";

const originalDatabaseUrl = process.env.DATABASE_URL;

const fakeExtractor: TextExtractor = {
  async extract(input: SourceTextInput) {
    if (input.kind === "url") {
      if (input.location.includes("unreachable")) {
        throw new Error("URL is unreachable");
      }
      return "Fetched body.";
    }
    return input.content;
  }
};

afterEach(() => {
  setServicesForTests(undefined);
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function setup() {
  const store = new MemoryStore(createFixtureState());
  setStoreForTests(store);
  process.env.DATABASE_URL = "postgres://source-contract";
  const services = getServices();
  const sources = new SourceService(store, fakeExtractor);
  setServicesForTests({
    workspace: services.workspace,
    runs: services.runs,
    discussions: services.discussions,
    sources
  });
  return { store, sources };
}

describe("Source HTTP contract", () => {
  it("creates and lists a file Source without exposing raw content", async () => {
    setup();
    const created = await handleApiRequest(
      new Request("http://localhost/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "file",
          location: "notes.md",
          content: "One.\n\nTwo."
        })
      }),
      ["sources"]
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.status).toBe("ready");
    expect(body.chunkCount).toBe(2);
    expect("pendingContent" in body).toBe(false);

    const listed = await handleApiRequest(
      new Request("http://localhost/api/sources"),
      ["sources"]
    );
    const list = await listed.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(body.id);
    expect("pendingContent" in list[0]).toBe(false);
  });

  it("lists a Source's chunks", async () => {
    setup();
    const created = await handleApiRequest(
      new Request("http://localhost/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "file", location: "notes.md", content: "A.\n\nB." })
      }),
      ["sources"]
    );
    const body = await created.json();

    const chunksResponse = await handleApiRequest(
      new Request(`http://localhost/api/sources/${body.id}/chunks`),
      ["sources", body.id, "chunks"]
    );
    const chunks = await chunksResponse.json();
    expect(chunks.map((chunk: { content: string }) => chunk.content)).toEqual([
      "A.",
      "B."
    ]);
  });

  it("creates a URL Source as pending, then retries it once it fails", async () => {
    const { sources } = setup();
    const created = await handleApiRequest(
      new Request("http://localhost/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "url",
          location: "https://example.com/unreachable"
        })
      }),
      ["sources"]
    );
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.status).toBe("pending");

    // Retry is only valid for failed Sources; the pending Source is rejected.
    const rejected = await handleApiRequest(
      new Request(`http://localhost/api/sources/${body.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      ["sources", body.id, "retry"]
    );
    expect(rejected.status).toBe(409);

    // Drive the unreachable URL to failed, then retry it.
    await sources.ingestPendingSources();
    const retried = await handleApiRequest(
      new Request(`http://localhost/api/sources/${body.id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }),
      ["sources", body.id, "retry"]
    );
    const afterRetry = await retried.json();
    expect(afterRetry.status).toBe("failed");
    expect(afterRetry.error).toBe("URL is unreachable");
  });

  it("deletes a Source and its chunks", async () => {
    setup();
    const created = await handleApiRequest(
      new Request("http://localhost/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "file", location: "notes.md", content: "One." })
      }),
      ["sources"]
    );
    const body = await created.json();

    const deleted = await handleApiRequest(
      new Request(`http://localhost/api/sources/${body.id}`, { method: "DELETE" }),
      ["sources", body.id]
    );
    expect(deleted.status).toBe(204);

    const listed = await handleApiRequest(
      new Request("http://localhost/api/sources"),
      ["sources"]
    );
    expect(await listed.json()).toEqual([]);
  });
});
