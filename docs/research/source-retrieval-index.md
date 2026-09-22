# Source retrieval: embeddings, vector search, and store-level indexing

Research ticket: https://github.com/sihuayin/multi-chats/issues/101
Follows prior research: https://github.com/sihuayin/multi-chats/issues/91 (write-up `docs/research/pi-ai-embedding-support.md`, branch `research/pi-ai-embeddings`).

**Recommendation (TL;DR): keep the in-memory keyword IDF ranking. Do not add a store-level keyword index or embeddings/vector search now.** At the v1 scale this app targets — a single workspace whose Sources hold tens to low hundreds of chunks — a store-level index buys no latency (the chunk text is already in memory) and only a hypothetical, unmeasurable ranking-quality gain, at the cost of ending the single-document store, adding a second source of truth to keep in sync, and (for embeddings) a new BYOK credential surface. Revisit only past a concrete trigger (below).

---

## 1. The retrieval path as it exists today

Primary source: `src/server/application/source-retrieval.ts`, `src/server/application/discussion-context.ts`.

- The query is the user's framing — title + note + questions — never a live model turn (`discussionRetrievalQuery`, `source-retrieval.ts:15-23`).
- The candidate set is every `ready` chunk of every attached Source, in source-then-index order (`attachedReadyChunks`, `source-retrieval.ts:30-43`).
- Ranking is deterministic in-memory IDF: tokenize (lowercase, keep `\p{L}\p{N}`), score each chunk by `Σ log(1 + N/df)` over query terms, break ties by chunk index (`rankChunks`, `source-retrieval.ts:51-87`).
- The ranked result is **not** filtered to a top-k. `discussion-context.ts:238-256` maps *all* ranked chunks to `source_context` messages, and the context assembler then appends them in rank order until the input budget is exhausted (`discussion-context.ts:698-708`, which silently `continue`s past the budget). So ranking is purely an *ordering* concern: it decides which chunks survive the context-window cut, not whether a chunk is retrieved at all.

### The architectural fact that dominates this decision

The store is a single JSON document. Both backends persist the entire `AppState` — including all `Chunk.content` — in one row and materialize it fully on every access:

- Postgres: one `app_state` row, `state jsonb` (`src/server/store/postgres-store.ts:17-39`); `read()`/`update()` `SELECT` the whole blob, and `update()` rewrites the whole blob (`postgres-store.ts:41-68`).
- SQLite: one `app_state` row, `state TEXT` (`src/server/store/sqlite-store.ts:69-100`); same load/rewrite-whole-blob pattern (`sqlite-store.ts:32-62`).

Chunks live in `state.chunks` (`src/server/domain/types.ts:672`; `Chunk` shape at `:442-451`, `Source` at `:426-440`). Ingestion pushes them into that array (`src/server/application/source-service.ts:203-215`).

Consequence: by the time `rankChunks` runs inside `buildDiscussionContext`, the full text of every chunk is **already in memory** as part of the loaded state. A store-level index (FTS5, Postgres `tsvector`, or pgvector) cannot avoid loading chunk text; it can only accelerate or re-rank the *computation over text that is already loaded*. That computation is O(chunks × queryTerms) — a few thousand Set lookups for a few hundred chunks — i.e. sub-millisecond, run once per turn assembly. At this scale a store-level index saves nothing measurable.

---

## 2. Item 1 — do `pi-ai` / `pi-agent-core` (0.85.1) expose embeddings or a vector store?

Re-verified against the **installed** packages (`node_modules/@earendil-works/pi-ai@0.85.1`, `@earendil-works/pi-agent-core@0.85.1`), not npm/docs. Conclusion of #91 still holds: **no**.

- Case-insensitive `grep -ril "embedding"` over both `dist/` trees (`.d.ts`, `.js`, `.js.map`, JSON catalogs): **0 matches** in `pi-ai`, **0** in `pi-agent-core`.
- `grep -rilE "pgvector|cosine|hnsw|faiss|similarity|vector-store|vectorstore"` over both `dist/` trees: **0 matches**.
- `pi-ai` `exports` map exposes only `.`, `./compat`, `./providers/*`, `./api/*`, `./utils/*`, `./oauth`, `./bedrock-provider`, `./bun-oauth` — no `./embeddings` or per-provider embedding subpath.
- `pi-agent-core` `exports` map is chat/session-oriented; its `SessionSearchService` seam is a full-text session-search plug-in (empty compiled implementation), not a vector/similarity primitive — and it is for *session* search, not Source chunk retrieval.

So any embedding or vector capability must be added out-of-band (separate embedder client or local model), exactly as #91 concluded.

---

## 3. Item 2 — pgvector migration cost on the current Postgres backend

The vector index cannot index into the `app_state.state` JSON blob; it must be a **side table keyed by chunk** (e.g. `chunk_embedding(chunk_id, source_id, embedding vector(N))`). That carries real costs:

1. **Second source of truth + sync.** Because `update()` rewrites the whole blob (`postgres-store.ts:56-59`), the store would have to diff `state.chunks` against the side table and upsert/delete rows inside the same transaction, on every update. That breaks the "one JSON document, no derived tables" invariant, adds a consistency surface that can drift, and adds a second migration surface next to the schema-version migrations in `src/server/store/migrations.ts`.
2. **Image change.** `docker-compose.yml` runs `postgres:17-alpine`, which does **not** ship pgvector. Adoption means swapping to `pgvector/pgvector:pg17` (current 0.8.x) or `apk add postgresql-pgvector`, plus `CREATE EXTENSION vector` per database — a deployment change imposed on every self-hoster, not just the app. (pgvector README: `docker pull pgvector/pgvector:pg17`; index types HNSW/IVFFlat; operators `<=>`, `<#>`, `<->`.)
3. **It only solves half the problem.** pgvector stores and searches vectors; it does not produce them. Item 4 shows embeddings must come from a separate BYOK provider or a local model — so the embedder pipeline, credential path, and re-embedding-on-change logic are all additional to the pgvector work.
4. **Test/offline surface.** `@electric-sql/pglite` 0.5.8 is a devDependency but is not imported anywhere in `src`/tests today; Postgres store tests run against a real `TEST_DATABASE_URL` and are skipped when unset (`src/server/store/postgres-store.test.ts:6-7`). A pgvector path would need to keep the offline/SQLite dev story working anyway, since pgvector has no SQLite equivalent.

Net: pgvector is the highest-cost option here, and its only payoff (approximate nearest-neighbor over vectors) doesn't exist until there is an embedder and a scale where in-memory ranking is insufficient — neither of which holds at v1.

---

## 4. Item 3 — what FTS5 / Postgres full-text buys over in-memory IDF

For a single workspace with tens to low hundreds of chunks:

- **Latency: nothing.** The corpus is already in memory (see §1), so the in-memory scan is already microseconds. An inverted index's sub-linear query is irrelevant when N is a few hundred and the data is resident.
- **Ranking quality: marginal and unverified.** FTS5/`tsvector` would give BM25-style term weighting, stemming, and phrase operators vs. the current plain IDF-over-token-set. That is a real but small quality delta, and it is not demonstrated to matter for this query shape (user framing text vs. source text — a topical-keyword match, which IDF already serves). It cannot be measured without a retrieval eval set, which the repo does not have.
- **Cost: reintroduces everything §3 item 1 lists.** An FTS5 virtual table (content-synced or trigger-maintained) or a generated `tsvector` column is again a side structure keyed by chunk that must stay in sync with `state.chunks`, and its tokenizer diverges from the JS tokenizer in `source-retrieval.ts:3-9` that today's deterministic, test-asserted behavior depends on (`src/server/application/source-retrieval.test.ts`).

So the store-level *keyword* index buys essentially nothing at v1 scale and costs the same dual-write complexity as pgvector, minus the embedder.

---

## 5. Item 4 — BYOK embedding providers and the token/cost implication

Which of the seven supported providers (`src/server/adapters/model/provider-registry.ts:28-36`) even offer embeddings:

| Provider | Embeddings API? | Model / dims / price (per 1M tokens) |
|---|---|---|
| OpenAI | Yes | `text-embedding-3-small` $0.02 / 1536d; `text-embedding-3-large` $0.13 / 3072d; legacy `ada-002` $0.10 |
| Google | Yes | `text-embedding-004` 768d (Gemini API free tier; ~$0.025/1M paid); `gemini-embedding-001` 3072d $0.15 |
| Mistral | Yes | `mistral-embed` 1024d, ~$0.10/1M |
| OpenRouter | Yes (passthrough) | `POST /api/v1/embeddings` routing OpenAI/Google/etc. models; data-policy caveats |
| Anthropic | **No** | Messages API only, no embedding endpoint |
| Groq | **No** | inference-only, no embeddings |
| DeepSeek | **No** | chat + FIM completions only |

Fully offline / no-managed-service options also fit BYOK: Ollama (`nomic-embed-text`), `sentence-transformers` / `@huggingface/transformers` / `@xenova/transformers` run locally at zero marginal cost — the truest "no managed service" answer.

**Cost of embedding every chunk.** Chunks are ≤ `DEFAULT_CHUNK_MAX_CHARS = 4_000` (`src/server/application/source-chunking.ts:4`). Roughly 1,000–4,000 tokens per chunk depending on language. A 300-chunk corpus is ≤ ~1.2M tokens ≈ **$0.02–$0.03 one-time** on `text-embedding-3-small`; 1,000 chunks ≈ $0.06. Dollar cost is effectively negligible.

The real cost is **operational**, not monetary:

- A new credentialed network dependency at **ingestion time** (chunks are created synchronously on Source attach, `source-service.ts:203-215`), adding latency, failure/retry modes, and re-embedding on any chunk or embedding-model change.
- A new credential path: today the app validates a provider key with a chat completion (`src/server/adapters/model/provider-registry.ts:113-152`); embeddings need an embedding-capable key, and several of the seven providers (Anthropic/Groq/DeepSeek) can't supply one.
- All of §3's side-table + sync + migration cost, on both backends if you want SQLite and Postgres parity.

---

## 6. Cost/benefit and the trigger

**Decision: keep in-memory keyword IDF (v1).** It is deterministic, dependency-free, credential-free, already test-covered, and bounded by work the system is already doing (the corpus is in memory regardless).

- *Keep in-memory keyword* — zero added cost; the ranking is adequate for the query shape at this scale.
- *Store-level keyword index (FTS5/tsvector)* — positive cost (dual-write, second tokenizer, per-backend migration), near-zero benefit at tens-to-hundreds of chunks; only its ranking-quality delta could matter, and that's unproven.
- *Embeddings/vector (pgvector or side-table vectors)* — the largest cost (embedder + credential + image change + sync + re-embed) for a semantic-recall benefit that only pays off when keyword recall is demonstrably failing, which has not been shown.

**Trigger to revisit —** move off in-memory keyword only once *both* conditions hold:

1. **Scale:** a single workspace's attached-ready corpus reaches the **thousands of chunks** (roughly **≥ 2,000–5,000 chunks** in a Discussion, or the total `state.chunks` corpus becomes a measurable memory/ranking cost), *and*
2. **Measured recall gap:** a retrieval evaluation (or consistent user reports) shows the IDF ranking is dropping chunks the Discussion needs — e.g. paraphrase/synonym misses that embeddings would catch.

At that point the cheaper first step is a **store-level keyword index** (FTS5 or `tsvector`), not pgvector: keyword matching stays well-aligned with the "framing text vs. source text" query, and it needs no embedder or new credential. Promote to **embeddings/pgvector** only if the eval then still shows a recall gap that semantic search fixes.

## Sources

Primary (repo, installed code):
- `src/server/application/source-retrieval.ts` — tokenize, `discussionRetrievalQuery`, `attachedReadyChunks`, `rankChunks`
- `src/server/application/discussion-context.ts:238-256` (rank + inject all chunks), `:698-708` (budget cut)
- `src/server/application/source-chunking.ts:4` (4,000-char chunk cap); `src/server/application/source-service.ts:203-215` (chunk ingestion)
- `src/server/domain/types.ts:426-451` (Source/Chunk shapes), `:672` (`state.chunks`)
- `src/server/store/postgres-store.ts`, `src/server/store/sqlite-store.ts`, `src/server/store/migrations.ts`
- `src/server/adapters/model/provider-registry.ts:28-36` (seven providers), `:113-152` (chat-based credential validation)
- `docker-compose.yml` (`postgres:17-alpine`), `package.json` (`pg` 8.18.0, `@electric-sql/pglite` 0.5.8 devDep, pi packages 0.85.1), `src/server/store/postgres-store.test.ts:6-7` (TEST_DATABASE_URL gate)
- `node_modules/@earendil-works/pi-ai@0.85.1`, `node_modules/@earendil-works/pi-agent-core@0.85.1` (grep of `dist/` + `exports` maps)

External (provider docs / primary specs):
- pgvector README — https://github.com/pgvector/pgvector (`pgvector/pgvector:pg17` image, HNSW/IVFFlat, `CREATE EXTENSION vector`)
- OpenAI embeddings — https://platform.openai.com/docs/guides/embeddings (3-small $0.02/1M 1536d, 3-large $0.13/1M 3072d, ada-002 $0.10/1M)
- Mistral embeddings — https://docs.mistral.ai (mistral-embed 1024d, ~$0.10/1M)
- Google Gemini API embeddings — https://ai.google.dev (text-embedding-004 768d free tier / ~$0.025-1M; gemini-embedding-001 3072d $0.15/1M)
- OpenRouter embeddings — https://openrouter.ai/docs/api_reference/embeddings
- Anthropic (Messages-only, no embeddings), Groq (inference-only, no embeddings), DeepSeek (chat + FIM only) — provider API reference docs
