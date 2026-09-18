import type { Chunk, Source } from "@/server/domain/types";
import { sourceCreateSchema } from "@/server/domain/schemas";
import { ApiError, notFound } from "@/server/application/errors";
import {
  chunkSource,
  contentHash
} from "@/server/application/source-chunking";
import type {
  SourceTextInput,
  TextExtractor
} from "@/server/application/text-extractor";
import type { StateStore } from "@/server/store/store";

function now(): string {
  return new Date().toISOString();
}

export function publicSource(source: Source): Source {
  const copy = structuredClone(source);
  delete copy.pendingContent;
  return copy;
}

export class SourceService {
  constructor(
    private readonly store: StateStore,
    private readonly extractor: TextExtractor
  ) {}

  async listSources(): Promise<Source[]> {
    return this.store.read((state) =>
      state.sources
        .slice()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(publicSource)
    );
  }

  async getSource(id: string): Promise<Source> {
    return this.store.read((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) notFound("Source");
      return publicSource(source);
    });
  }

  async listChunks(sourceId: string): Promise<Chunk[]> {
    return this.store.read((state) => {
      if (!state.sources.some((item) => item.id === sourceId)) {
        notFound("Source");
      }
      return state.chunks
        .filter((chunk) => chunk.sourceId === sourceId)
        .sort((left, right) => left.index - right.index)
        .map((chunk) => structuredClone(chunk));
    });
  }

  async createSource(input: unknown): Promise<Source> {
    const parsed = sourceCreateSchema.parse(input);
    const id = crypto.randomUUID();
    await this.store.update((state) => {
      const timestamp = now();
      const source: Source = {
        id,
        workspaceId: state.workspace.id,
        title: parsed.title ?? parsed.location,
        kind: parsed.kind,
        location: parsed.location,
        status: "pending",
        chunkCount: 0,
        ...(parsed.kind === "file"
          ? { pendingContent: parsed.content }
          : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.sources.push(source);
      state.workspace.updatedAt = timestamp;
    });
    // File content is already in hand; ingest it inline so the caller sees a
    // terminal status immediately. URL sources are picked up asynchronously by
    // ingestPendingSources (worker) or an inline trigger (SQLite mode).
    if (parsed.kind === "file") {
      await this.ingestSource(id);
    }
    return this.getSource(id);
  }

  async retrySource(id: string): Promise<Source> {
    const current = await this.store.read((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) notFound("Source");
      return {
        status: source.status,
        kind: source.kind,
        pendingContent: source.pendingContent
      };
    });
    if (current.status !== "failed") {
      throw new ApiError(
        409,
        "Only failed Sources can be retried",
        "source_not_failed"
      );
    }
    await this.store.update((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) notFound("Source");
      const timestamp = now();
      source.status = "pending";
      source.error = undefined;
      source.contentHash = undefined;
      source.chunkCount = 0;
      source.updatedAt = timestamp;
      state.chunks = state.chunks.filter((chunk) => chunk.sourceId !== id);
      state.workspace.updatedAt = timestamp;
      if (current.kind === "file" && current.pendingContent !== undefined) {
        source.pendingContent = current.pendingContent;
      }
    });
    await this.ingestSource(id);
    return this.getSource(id);
  }

  async deleteSource(id: string): Promise<void> {
    await this.store.update((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) notFound("Source");
      state.chunks = state.chunks.filter((chunk) => chunk.sourceId !== id);
      state.sources = state.sources.filter((item) => item.id !== id);
      for (const discussion of state.discussions) {
        discussion.sourceIds = discussion.sourceIds.filter(
          (sourceId) => sourceId !== id
        );
      }
      state.workspace.updatedAt = now();
    });
  }

  async ingestPendingSources(): Promise<number> {
    const pending = await this.store.read((state) =>
      state.sources
        .filter((source) => source.status === "pending")
        .map((source) => ({
          id: source.id,
          kind: source.kind,
          location: source.location,
          pendingContent: source.pendingContent
        }))
    );
    let count = 0;
    for (const item of pending) {
      await this.ingestSource(item.id);
      count += 1;
    }
    return count;
  }

  async ingestSource(id: string): Promise<Source> {
    const input = await this.store.update((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source || source.status !== "pending") return null;
      source.status = "ingesting";
      source.updatedAt = now();
      state.workspace.updatedAt = source.updatedAt;
      return {
        kind: source.kind,
        location: source.location,
        content: source.pendingContent
      } as SourceTextInput & { content?: string };
    });

    if (!input) return this.getSource(id);

    let text: string;
    try {
      text = await this.extractor.extract(
        input.kind === "url"
          ? { kind: "url", location: input.location }
          : {
              kind: "file",
              location: input.location,
              content: input.content ?? ""
            }
      );
    } catch (error) {
      await this.store.update((state) => {
        const source = state.sources.find((item) => item.id === id);
        if (!source) return;
        source.status = "failed";
        source.error = error instanceof Error ? error.message : String(error);
        source.updatedAt = now();
        state.workspace.updatedAt = source.updatedAt;
      });
      return this.getSource(id);
    }

    await this.store.update((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) return;
      const timestamp = now();
      state.chunks = state.chunks.filter(
        (chunk) => chunk.sourceId !== id
      );
      const chunks = chunkSource({
        sourceId: id,
        workspaceId: state.workspace.id,
        text,
        now: timestamp
      });
      state.chunks.push(...chunks);
      source.status = "ready";
      source.contentHash = contentHash(text);
      source.chunkCount = chunks.length;
      source.error = undefined;
      source.pendingContent = undefined;
      source.updatedAt = timestamp;
      state.workspace.updatedAt = timestamp;
    });
    return this.getSource(id);
  }

  async refreshSource(id: string): Promise<Source> {
    const current = await this.store.read((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) notFound("Source");
      return {
        kind: source.kind,
        status: source.status,
        location: source.location,
        contentHash: source.contentHash
      };
    });
    if (current.kind !== "url") {
      throw new ApiError(
        400,
        "Only URL Sources can be refreshed",
        "source_not_url"
      );
    }
    if (current.status !== "ready") {
      throw new ApiError(
        409,
        "Only ready Sources can be refreshed",
        "source_not_ready"
      );
    }

    let text: string;
    try {
      text = await this.extractor.extract({
        kind: "url",
        location: current.location
      });
    } catch (error) {
      throw new ApiError(
        502,
        error instanceof Error ? error.message : String(error),
        "source_refresh_failed"
      );
    }
    const hash = contentHash(text);
    if (hash === current.contentHash) {
      return this.getSource(id);
    }

    await this.store.update((state) => {
      const source = state.sources.find((item) => item.id === id);
      if (!source) return;
      const timestamp = now();
      for (const chunk of state.chunks) {
        if (chunk.sourceId === id) chunk.superseded = true;
      }
      const chunks = chunkSource({
        sourceId: id,
        workspaceId: state.workspace.id,
        text,
        now: timestamp
      });
      state.chunks.push(...chunks);
      source.status = "ready";
      source.contentHash = hash;
      source.chunkCount = chunks.length;
      source.error = undefined;
      source.updatedAt = timestamp;
      state.workspace.updatedAt = timestamp;
    });
    return this.getSource(id);
  }
}
