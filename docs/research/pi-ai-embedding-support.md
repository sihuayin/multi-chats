# pi-ai / pi-agent-core: embedding and vector support

Research ticket: https://github.com/sihuayin/multi-chats/issues/91
Status: research complete. Both packages are pinned at `0.85.1` in `package.json`.

Primary sources inspected (installed code, not npm/docs):

- `node_modules/@earendil-works/pi-ai@0.85.1` (`dist/` — `.d.ts`, `.js`, `.js.map`, and JSON model catalogs)
- `node_modules/@earendil-works/pi-agent-core@0.85.1` (`dist/`)
- `node_modules/@earendil-works/chord` (referenced by pi-agent-core as the facet-service runtime; checked for completeness)

## TL;DR

Neither `@earendil-works/pi-ai` nor `@earendil-works/pi-agent-core` (0.85.1) exposes any
embedding generation, any vector store, or any similarity-search primitive. There is no
`embed()` function, no embedder type, no embedding model entry, and no embedding API group
anywhere in either package. None of the seven providers this repo supports
(`openai`, `anthropic`, `google`, `openrouter`, `deepseek`, `groq`, `mistral`) ships an
embedding submodule or export. Embedding/vector search must be added out-of-band.

---

## Q1 — Does either package expose embedding generation?

**No.** A case-insensitive search for `"embedding"` across the full `dist/` tree of both
packages (including `.d.ts`, `.js`, `.js.map`, and JSON catalogs) returns **zero matches**.

The only `"embed"` hits are unrelated:

- `pi-ai/dist/bun-oauth.js` / `bun-oauth.d.ts` — "OAuth flows statically **embedded** in the standalone Bun binary"
- `pi-ai/dist/api/bedrock-converse-stream.js` — "ARN-**embedded** > explicit option > env vars"

There is no `embed()` export, no `Embedder` / `EmbeddingModel` symbol, and no embedding type.

Supporting evidence in the type surface:

- `pi-ai/dist/models.d.ts` — the `Provider<TApi>` interface exposes only:
  `getModels()`, `refreshModels?()`, `filterModels?()`, `stream()`, `streamSimple()`,
  `fetchDeferred?()`, `cancelDeferred?()`. **No `embed()` member.**
- `pi-ai/dist/types.d.ts` — the `ProviderStreams` interface (the contract for every API module)
  exposes only `stream`, `streamSimple`, `fetchDeferred?`, `cancelDeferred?`.
- `pi-ai/dist/types.d.ts` — `KnownApi` lists only chat/message APIs:
  `openai-completions | mistral-conversations | openai-responses | azure-openai-responses |
  openai-codex-responses | anthropic-messages | bedrock-converse-stream |
  google-generative-ai | google-vertex | pi-messages`.
  `KnownImagesApi` is only `"openrouter-images"`. There is no embeddings API.
- `pi-ai/dist/types.d.ts` — the `Model<TApi>` interface has no dimension/output-vector field.
  Its fields are: `id, name, api, provider, baseUrl, reasoning, thinkingLevelMap, input,
  cost, contextWindow, maxTokens, samplingParams?, headers?, compat?`.
- The union of every model-entry field across all 39 JSON catalogs under
  `pi-ai/dist/providers/data/*.json` is:
  `api, baseUrl, compat, contextWindow, cost, headers, id, input, maxTokens, name,
  provider, reasoning, thinkingLevelMap` — no `dimension` or embedding-output field exists
  for any model in the built-in catalog.

## Q2 — Does it expose a vector-store or similarity-search primitive?

**No vector store, and no similarity search.**

- `pi-agent-core/dist/harness/session/memory.d.ts` — `MemoryStorage` / `MemorySessionRepo`
  are in-memory session/entry persistence (`Storage` / `SessionRepo` implementations), not
  vector memory.
- `pi-agent-core/dist/search/index.d.ts` — defines an abstract `SessionSearchService`
  interface with `searchSessions(query)` and optional `searchEntries(query)` plus
  `sync/notify/remove/close`. This is a **full-text session/entry search hook**, not a vector
  or similarity-search primitive:
  - The compiled module is empty (`index.js` is just `export {}`), so **no implementation ships**
    in the package.
  - The interface is not referenced anywhere else in `pi-agent-core` (only its own definition
    and source map). It is a plug-in seam for an external search backend, not an embedding or
    ANN index.
  - The `score?: number` field is an opaque ranking score with no cosine/dot-product semantics.

Neither package mentions "vector", "pgvector", "cosine", "faiss", "hnsw", or "similarity" in any
semantic sense. (The only `"vector"` hits are Recraft image model names like
`recraft/recraft-v4-vector` in `pi-ai/dist/image-models.generated.*`, which output SVG, not
embedding vectors.)

## Q3 — Embedding support per supported provider

Each provider ships as a factory plus a static model catalog. None has an embedding
submodule/export, and no catalog has an embedding API group. Concrete exports and catalog
contents:

| Provider | Factory export (`pi-ai/dist/providers/`) | Returned API type(s) | Catalog groups (models) |
|---|---|---|---|
| `openai` | `openaiProvider()` | `Provider<"openai-responses">` | `openai-responses` (39) |
| `anthropic` | `anthropicProvider()` | `Provider<"anthropic-messages">` | `anthropic-messages` (14) |
| `google` | `googleProvider()` | `Provider<"google-generative-ai">` | `google-generative-ai` (22) |
| `openrouter` | `openrouterProvider()` | `Provider<"anthropic-messages" \| "openai-completions">` | `anthropic-messages` (15), `openai-completions` (351) |
| `deepseek` | `deepseekProvider()` | `Provider<"openai-completions">` | `openai-completions` (3) |
| `groq` | `groqProvider()` | `Provider<"openai-completions">` | `openai-completions` (7) |
| `mistral` | `mistralProvider()` | `Provider<"mistral-conversations">` | `mistral-conversations` (32) |

- All seven `Provider<...>` types are chat-only. There is no `embedding` API in any of them.
- No embedding model IDs, dimensions, or token limits are exposed — because no embedding
  models exist in the catalogs at all. (Model entries carry no `dimension` field, per Q1.)
- The `@earendil-works/pi-ai` package `exports` map (`package.json`) exposes `.`, `./compat`,
  `./providers/*`, `./api/*`, `./utils/*`, `./oauth`, `./bedrock-provider`, `./bun-oauth` —
  there is **no `./embeddings` or per-provider embedding subpath**.

## Q4 — Fallback paths (since neither package provides embeddings)

Embedding generation and vector storage are outside pi-ai/pi-agent-core at 0.85.1. Options:

1. **Self-managed embedder (recommended)** — call provider embedding REST endpoints directly
   alongside pi-ai, or add a small dedicated embedding client:
   - OpenAI `POST /v1/embeddings` (`text-embedding-3-small` 1536d, `text-embedding-3-large` 3072d,
     `text-embedding-ada-002` 1536d)
   - Mistral `POST /v1/embeddings` (`mistral-embed`, 1024d)
   - Google `models/text-embedding-004` / `gemini-embedding-001` via the Generative Language API
   - Others via their own SDKs, or a local model (e.g. `@xenova/transformers`,
     `@huggingface/transformers`, `sentence-transformers`) for zero-cost/offline embeddings.
   These run beside pi-ai; pi-ai continues to own chat/completion streaming.

2. **pgvector with a separate client** — the repo already runs PostgreSQL 17
   (`docker-compose.yml`, `pg` 8.18.0, `@electric-sql/pglite` for dev/tests). Enable the
   `pgvector` extension in that Postgres, store embeddings produced by the self-managed
   embedder, and query with `<=>` / `<->` via the existing `pg` client. No changes to pi-ai.

3. **External vector DB** — Pinecone, Qdrant, Weaviate, or a managed pgvector Postgres
   (Supabase/Neon) with its own client library. Embeddings still have to be produced by a
   self-managed embedder first.

If in-package session search is the goal, `pi-agent-core`'s exported `SessionSearchService`
interface (`dist/search/index.d.ts`, re-exported from the package root via `index.d.ts`) is
the intended seam: a backend that implements `searchSessions` / `searchEntries` (e.g. one that
ranks by pgvector similarity) can be plugged in without forking pi-agent-core. But the
embedding computation and vector index remain the caller's responsibility.
