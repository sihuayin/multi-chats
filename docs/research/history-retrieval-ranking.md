# Ranking retrieval over a conversation history

Research ticket: https://github.com/sihuayin/multi-chats/issues/189
Consuming decision ticket: https://github.com/sihuayin/multi-chats/issues/192
Parent map: https://github.com/sihuayin/multi-chats/issues/188

Prior work this builds on, not repeated here. Both documents are in `docs/research/` alongside this one:

- `docs/research/pi-ai-embedding-support.md` (#91) —
  `pi-ai` / `pi-agent-core` 0.85.1 expose no embedding, vector-store, or similarity-search
  primitive, and none of the seven supported providers ships an embedding submodule.
- `docs/research/source-retrieval-index.md` (#101) — the
  in-memory keyword ranker is the right v1 for Sources; the revision trigger is ~2,000–5,000
  units **and** a measured recall gap.

Neither conclusion is reopened here. Both were about *Sources*; this ticket is about a corpus
with authorship, timestamps, and Conversation membership, which is a different input to the same
ranker.

**How to read this document.** Every claim carries an evidence marker, because the consuming
ticket must be able to tell measurement from habit:

| marker | means |
| --- | --- |
| **[exec]** | I ran code on this machine and the number is in this document. Reproducible. |
| **[read]** | Read out of source, a spec, or a paper in this repo or in the cited primary source. |
| **[measured-lit]** | A peer-reviewed or archival published result with a named dataset and metric. Cited. |
| **[vendor-measured]** | A vendor measuring its own shipped system and reporting the number. A primary source for *what they measured and shipped*, not independently replicated. |
| **[documented]** | A vendor or operator describing its own shipped behaviour — API docs, source code, an engineering post. A primary source for *what they do*; **not** evidence that it works. |
| **[convention]** | Widely done, no measurement found that supports it. Flagged as such on purpose. |
| **[unmeasured]** | I looked for a primary source and found none. Recorded so a later reader does not assume the claim is merely uncited. |
| **[opinion]** | My judgement. Not evidence. |

**On provenance.** Everything marked **[exec]** I ran here. The repo claims marked **[read]** I
checked against the file and line cited. Of the external sources, I fetched and read **Li & Croft
(CIKM 2003)**, the **Elasticsearch decay-function docs**, **Slack's engineering post**, and
**Reddit's `_sorts.pyx`** directly and quote them verbatim. The remaining external material was
retrieved by three delegated readers working from the same brief; where a specific source was
**not** read by anyone, it is listed under "Sources explicitly not read here" at the end, and
where a whole table rests on a delegated reading I say so next to it (see the provenance note in
§2.1). Treat **[measured-lit]** citations as pointers to a named dataset and metric that a
sceptical reader should spot-check, not as independently replicated results.

The `[exec]` results were produced by running the **real** `rankChunks` against a synthetic
corpus — the shipped function, not a reimplementation. They are measurements of the ranker's
behaviour, not of this product's retrieval quality: no real Workspace corpus or labelled
relevance set exists, so no effectiveness number in this document is a quality claim.

---

## Headline

**The ranking question #192 is asking has a different shape than expected.** `rankChunks` does not
have a recency signal that is missing; it has a **third sort key** that already decides the
majority of every result set on this corpus — 100% of the output for a short query, 62% for a
model-authored one **[exec]**. Porting the ranker to Messages therefore *is* choosing a recency
policy, whether or not one is chosen deliberately, because the only available analogue of
`chunk.index` is `createdAt`.

Everything else follows from that, plus two measured corpus problems: a Brief's JSON is scored
partly on its **structural keys** (one matched key already equals the rarest possible term-hit
**[exec]**), and a reply that answers a question without restating its topic is separated from it
by **121 other messages** on a relevance-only ordering **[exec]**.

The external evidence lands in five places.

- **Recency is not folklore, and it is not a free win either.** Slack — a production message
  corpus — measured relevance-only ordering as performing **worse than reverse-chronological**,
  and put *message age* among the top signals of the re-ranker that fixed it
  **[vendor-measured]**. Li & Croft (CIKM 2003) is the canonical prior-on-document-age result, and
  its scope condition is that it applies to **recency queries**, with the counter-example stated in
  the same paragraph **[measured-lit]**. On a tweet corpus, relevance and recency were **negatively
  correlated for most topics**, and a thresholded plain relevance ranking beat the newest-first
  system (Carterette et al., TREC 2011) **[measured-lit]**. Discord defaults to `timestamp`,
  Mattermost's own DB path sorts by creation time, and Zulip documents no ranking at all
  **[documented]**.
- **Decomposing an item into parts alone loses.** Callan (SIGIR 1994) measured best-passage-only
  retrieval at **−2.9%** and **−27.9%** average precision against document-level, with combining
  the two levels winning **[measured-lit]**. This is the closest measured evidence to #192's
  "is a Brief one item or decomposed into parts", and it argues for *combining*, not replacing.
- **Adding metadata to retrieved context is not safe.** The largest measured study found "adding
  more metadata reduces accuracy on every benchmark; structure alone degrades reasoning", with
  timestamps paying off only for date-comparison tasks **[measured-lit]**.
- **Tie-breaking is a measured mechanism, and recency was deliberately left out of it.**
  Lexicographic tie-breaking beat both single-score baselines on Tweets2011 (P@30 0.4204 vs 0.3782
  and 0.3964) **[measured-lit]** — so the *cascade* in `rankChunks` is sound and the open question
  is what goes in it. The signals tested were IDF, TF, NOF and document length; **no temporal
  signal was tested**, "temporal-related signals" were named as future work, and nobody has added
  one since **[convention]**. Choosing recency as a tie-break here would be first, not following.
- **Author authority measured out at ~zero on a message corpus.** Ablating the author-badge feature
  from a Stack Overflow answer ranker moved P@1 by **+.003** (removing it *helped*), and the same
  ablation found date and view-count features worth **+.001** **[measured-lit]**. The literature
  where authorship does measure strongly — expert finding — ranks **people**, not messages.

**What is *not* measured anywhere I could reach, and should not be assumed:** that a reply is
unintelligible without its parent; that conversation-level indexing beats message-level;
"same-conversation boost" as any product's documented behaviour; that author authority improves
the ranking of messages rather than of people; that an answer should outrank the question it
answers; and any measured basis for the *shape* of a decay curve (linear vs exponential vs
Gaussian is a knob vendors present as interchangeable, and the docs give no criterion
**[convention]**).

### The one-page version

| question #192 asks | state of the evidence |
| --- | --- |
| Is recency load-bearing or folklore? | **Neither, exactly.** Measured to matter for message corpora (Slack), measured **only for recency-type queries** (Li & Croft), and measured **negatively for most topics** on a tweet corpus (Carterette, TREC 2011). Chronological is the shipped default in three message products. Decay *shape* is **[convention]**. |
| Which signals participate? | Term relevance and recency have measured support — recency conditionally (§2.1). Authorship-as-authority has **none here**: one human user (§1.4), and the one clean ablation on a message corpus measured it at ~zero (§2.4). Conversation proximity has **no graph to compute from** (§1.5). Status demotion is a documented product convention with published multipliers, measured nowhere (§2.5). |
| How do they combine? | Rank fusion has measured support (RRF, Cormack 2009) and score fusion is measured-fragile (Montague & Aslam 2001). Lexicographic *tie-breaking* is measured to beat both single-score baselines, with recency explicitly never tested (§2.2). The composite is **[convention]**. |
| Is a Brief one item or decomposed? | Decomposition *alone* is measured to lose (Callan 1994). Ranked whole, a Brief gets a measured structural-key advantage **[exec]**. |
| How is it asserted? | #165 routes this to unit tests; the existing 9 tests pin none of the properties that break (§1.8) **[read]**. |

---

## Part 1 — What `rankChunks` actually does, and what it assumes

### 1.1 The exact signal set

`rankChunks(chunks: Chunk[], query: string): Chunk[]` (`src/server/application/source-retrieval.ts:92-134`)
reads exactly two fields off each input — verified by reading every `chunk.` dereference in the
function body **[read]**:

| signal | source | how it enters |
| --- | --- | --- |
| `chunk.content` | the chunk text | tokenized; set membership per distinct query term |
| `chunk.index` | the chunk's position in its Source | **tertiary sort key only** |

That is the whole feature vector. `createdAt`, `updatedAt`, `sourceId`, `workspaceId`,
`contentHash`, `superseded` are all present on the `Chunk` type and **none is read** **[read]**.
There is no author field on `Chunk` to read.

The score is:

```
score(c) = Σ over distinct query terms t present in c of  log(1 + N / df(t))
         + (longest contiguous run of query terms appearing verbatim in c, if that run ≥ 2)
```

then sorted by `score` desc, `coverage` (count of distinct query terms matched) desc, `index` asc
(`source-retrieval.ts:127-132`).

### 1.2 Assumptions that hold for Chunks

1. **`index` is a total, meaningful order.** Every Chunk has a unique `index` within its Source
   (`types.ts:442-451`), assigned by ingestion, and Source order → chunk index order is the
   document's own order (`attachedReadyChunks`, `source-retrieval.ts:30-46`) **[read]**.
2. **The corpus is a set of prose passages.** Enforced upstream: Sources are chunked text with a
   4,000-char cap (`source-chunking.ts:4`) **[read]**.
3. **The candidate set is small and closed.** For Discussions it is the attached `ready` Sources'
   chunks (`source-retrieval.ts:34-45`) **[read]**.
4. **The query is user-authored framing.** `discussionRetrievalQuery` joins title + note +
   questions (`source-retrieval.ts:15-23`), and #102 justified that by *"determinism is
   non-negotiable"* **[read]**.

### 1.3 Which of those assumptions break on a Message corpus

**A. `index` does not exist, and the tie-break is not a detail.** *(breaks assumptions 1)*

Measured on a synthetic 402-item chat corpus that mirrors a real conversation history — mostly
short, off-topic-to-any-given-query messages plus two on-topic items **[exec]**:

| query length | distinct scores | largest tie group (identical score **and** coverage ⇒ ordered purely by the tertiary key) |
| --- | --- | --- |
| 1 term | 2 | **401 of 402 (100%)** |
| 4 terms | 3 | **400 of 402 (100%)** |
| 29 terms (model-authored natural language) | 5 | **250 of 402 (62%)**, then 100, then 50 |

Read that first row again: for an ordinary short query, **the entire output is the tertiary key**.
For a long, natural-language query — which is what a model-authored `search_history` query will
be — the corpus collapses into four or five score bands and the tertiary key orders the largest
band and every band below it.

For Chunks the tertiary key is `index`, i.e. document order, which is a defensible default. For
Messages there is no `index`; the obvious analogue is `createdAt`, and a tie-break on
`createdAt` **is a recency policy whether or not one was chosen**. Substituting "newest first"
for "lowest index" in that experiment moved **400 of 400 positions (100%)** **[exec]**.

The decision this forces on #192 is not "should we add recency decay?" — it is "the tie-break
already is the recency policy for the majority of every result set; name it or it is unnamed."
Part 2 §2.2 shows that tie-breaking is an established and measured *mechanism*, and that putting
recency in it is an untried one.
The same is true of the *second* key: coverage is a count of distinct query terms, so a
2,000-word Message matching six common query words outranks a 40-word Message matching five,
with no length penalty anywhere in the formula **[read]** — the concrete instance is measured in
(B) below **[exec]**.

**B. There is no length normalisation and no term frequency.** *(half of assumption 2)*

`score` sums once per *distinct* term present. Repeating a term adds nothing; padding a document
adds nothing **[read]**, and I confirmed both by running them **[exec]**:

- A 13-word Message containing one sentence and a 225-word Message containing **that same
  sentence plus 212 words of chatter** receive **identical scores**; the order between them is
  decided by the tie-break alone **[exec]**.
- An 89-word item built from 80 repetitions of one query term plus nine other common query terms
  **beats** a 14-word item containing the five genuinely on-topic rare terms **[exec]**.

  (Word counts here and below are whitespace-split; §1.3 D uses the repo's own token estimator,
  which is a different unit. Both are stated where used.)

BM25's length normalisation exists precisely to stop the second effect, and its absence is a
direct consequence of `rankChunks` being built for prose Chunks of similar size. Messages are not
of similar size. A conversation history contains one-word replies and multi-thousand-token
Employee answers in the same corpus.

**C. `df` is computed over the array you pass in, not over the corpus.** *(breaks assumption 3)*

`documentCount = Math.max(1, tokenized.length)` and every `df` is counted over the *passed* array
(`source-retrieval.ts:104-111`) **[read]**. So a document's score is a property of the array it
was ranked inside, not of the document. Measured, same two documents and same query **[exec]**:

| corpus | doc A (matches a common term) | doc B (matches the rare term) | winner |
| --- | --- | --- | --- |
| N=2 | 1.099 | 1.099 | A (index tie-break) |
| N=302 | 0.695 | 5.714 | **B — order flipped** |
| N=102 (200 filler docs dropped) | 0.698 | 4.635 | B |

Four consequences the ranking ticket has to decide around, none of which is a Chunk problem:

- A **per-Conversation opt-out** applied *before* ranking changes the score of every surviving
  item, and can reorder items the user did not exclude. Filtering is not order-preserving here
  **[exec]**, **[opinion]** on whether that is acceptable.
- A **top-k pre-cut** (rank 50, then rerank) computes a different `df` than ranking the full
  corpus **[read]**, so the cut is not a neutral performance optimisation.
- **Deleting a Conversation silently re-ranks the rest.** `deleteConversation`
  (`workspace-service.ts:532`) removes the Conversation's Messages with a `filter` (`:568-570`),
  which preserves the relative order of what remains **[read]** — but the remaining Messages' `df`
  values all change, so their scores change and their order can flip **[exec]** (the N=302 →
  N=102 row above). The map's constraint is that a deleted Conversation's citations dangle and
  that this "stays that way" (#188); this is a second, quieter effect of the same deletion, and
  it is not covered by any decision yet.
- The score is **not comparable across calls**. Any threshold ("drop everything below 3.0") is a
  threshold on a corpus-normalised quantity and will not transfer as history grows **[opinion]**.

**D. A Brief is JSON, and the tokenizer walks into it.** *(breaks assumption 2)*

`tokenize` (`source-retrieval.ts:3-9`) lowercases and keeps `\p{L}\p{N}`, splitting on everything
else. It has no notion of structure, so a JSON document is to it a bag of words that happens to
contain braces. Measured on a realistic `DiscussionBriefV2` (`discussion-brief.ts:31-101`) against
a prose Message carrying the same decision **[exec]**:

- **Size.** Using the repo's own estimator (`estimateTokenCount`, UTF-8 bytes / 3,
  `conversation-run-service.ts:197-199`): the same one-line decision is **55 tokens as prose and
  418 tokens as a Brief (×7.6)**, and **363 of those 418 tokens — 87% — are not the prose it
  carries** **[exec]**. Every one of them is retrievable, and none of them is a claim.
- **Key bias, and it is structural rather than a matter of which words the keys happen to be.**
  A token that appears in **every** Brief and in no Message has `df = K` (the Brief count), so it
  contributes `log(1 + N/K)` to every Brief — never zero. Over a 400-Message corpus **[exec]**:

  | Briefs in corpus | IDF per matched key | a Brief matching 6 keys | a Message matching one df=1 term |
  | --- | --- | --- | --- |
  | 1 | 5.99 | **35.96** | 5.99 |
  | 5 | 4.39 | **26.37** | 5.99 |
  | 12 | 3.54 | **21.22** | 5.99 |
  | 50 | 2.20 | **13.18** | 5.99 |

  **One matched Brief key already equals the rarest term-hit the corpus can produce
  (`log(1+N/1)`), and two beat it** — at every corpus size above. The keys are ordinary English, so a query written in the
  register of a decision record ("context", "constraints", "assumptions", "options", "risks",
  "open questions") hits them. I ran the concrete case: an **off-topic** Brief (about office
  plants) beat an **on-topic** Message for `"context problem options actions constraints
  assumptions"` and for `"title mode facts kind priority confidence"`, matching **only on its JSON
  keys** **[exec]**.

  How far this generalises depends on the query's vocabulary, and I measured that too rather than
  guessing: of 72 arbitrary high-frequency English words chosen *without* looking at the key list,
  exactly **1** (`problem`) is a literal Brief key **[exec]**. So this is not "every query prefers
  Briefs" — it is "a query phrased in decision-record vocabulary prefers Briefs, and a Brief
  carries ~7× the retrievable tokens of the prose it summarises."

  The second sort key compounds it: because **coverage** (count of distinct query terms matched)
  breaks score ties, a Brief's incidental coverage of common query words beats a Message that
  matched one rare term at equal score **[read]** on the formula.

- The Brief's identifiers (`discussionId`, `employeeId`, evidence aliases `external:<uuid>`)
  tokenize into hex fragments. I did **not** produce a collision and am not claiming one; the
  point is narrower — those fragments are retrievable terms that carry no meaning **[opinion]**.

- Phrase boost, for scale: with N=400 a 7-term verbatim phrase adds 7.0, **more than a rare-term
  hit** (`log(1+400/1) = 5.99`) **[exec]**. A long Message that quotes the query back wins on the
  phrase term alone.

**E. The corpus predicate is the caller's job, and it must run before ranking.** *(breaks assumption 3)*

`rankChunks` takes `Chunk[]` and returns all of them; it filters nothing **[read]**. Confirmed:
an empty-content item (a Message with `status` ≠ `complete` — `streaming`, `failed`, `cancelled`,
`interrupted` all exist on the type, `types.ts:310-323`) tokenizes to zero tokens, scores zero,
and is **returned**, sorted last **[exec]**.

Two predicates the history corpus needs, neither of which `rankChunks` can express:

- `status === "complete"` — and Messages are content-immutable, so a partial Message never
  becomes a complete one in place; it is excluded or it is noise **[read]**.
- **Discussion Turns are Messages.** A Discussion's employee Messages carry **both**
  `conversationId` and `discussionId` (`conversation-run-service.ts:2660-2674`) **[read]**, and
  `Discussion.conversationId` exists (`types.ts:636-639`) **[read]**. So a naive
  `messages.filter(m => m.conversationId !== current)` pulls Discussion turns into a corpus the
  map says they never cross into (#188: *"`turn:` and `tool_result:` never cross a Conversation
  boundary"*) **[read]**. Excluding them is a predicate; it also changes `df`, per (C).

**F. Author and timestamp are not signals the function can even accept.** *(breaks assumption 4)*

`rankChunks(chunks: Chunk[], query: string)` has no author parameter, and `Chunk` has no author
field **[read]**. Identical content eight years apart returns index order **[exec]**.

### 1.4 The authorship signal this corpus actually has

Worth stating precisely, because "authorship" sounds like a stronger signal than it is here.

There is **one human user**. `Message.authorType` is `"user" | "employee" | "system"`
(`types.ts:317`) and the user's `authorId` is the literal string `"user"`
(`conversation-run-service.ts:730-731`) **[read]**. There is no `users` collection in `AppState`
**[read]**. So "author authority" — which in an enterprise system means *which of many people
said it* — has **no population to discriminate over**. What the field can express is a
**discourse role**:

- `"user"` — the one human. Their messages are requests, corrections, and decisions.
- `"employee"` — an AI persona. N of these, and their trustworthiness is a product judgement,
  not a retrievable fact.
- `"system"` — lifecycle events (`conversation-run-service.ts:820-821`, `:1186-1187`) **[read]**.

The distinction that is *real* — and that a reader would find obvious if the ranker got it wrong
— is "the question vs. the answer it answers", which is a discourse-role question, not an
authority question. See Part 2 §2.4.

### 1.5 Conversation proximity has almost no structure to attach to

"How close is this Message's Conversation to mine?" needs an edge between Conversations. In this
data model the candidates are **[read]**:

- `Group` (`types.ts:294-299`) and `Conversation.groupId` (`types.ts:300-308`) — a Conversation
  can belong to a Group. **This is the only declared graph edge between two Conversations in
  `AppState`, and it is inert.** `groupId` is set once at creation (`workspace-service.ts:487-506`)
  and never read by any behaviour, and `Group.memberIds` is written and backed up but read by
  nothing — the only references outside CRUD are the backup validator
  (`backup-service.ts:166`, `:253`) **[read]**. So the edge exists in the schema without
  expressing anything the ranker could use.
- Shared participating Employees: `Conversation.memberIds` **is** read, for run member snapshots
  and Discussion participant validation (`conversation-run-service.ts:739-792`, `:1113`;
  `discussion-orchestrator.ts:341`) **[read]**. Two Conversations with the same member set is the
  one cross-Conversation relation that is both present and live — and it is derivable without
  Groups at all.
- `Conversation.updatedAt` / `createdAt` — a *temporal* adjacency, not a topical one. Note there
  is no `ConversationParticipant` record, so membership has no history to compare.
- `Message.taskId` / `Message.discussionId` — but `Task.conversationId` is a single Conversation
  (`types.ts:415`), so Tasks do not bridge Conversations **[read]**.

There is no reply graph, no mention graph, and no cross-Conversation reference anywhere in the
schema **[read]**. So "Conversation proximity" here can mean only two things — *near in time*, or
*shares participating Employees* — and it cannot mean *linked by a conversation*, because no such
link is recorded. Both of those are coarser than the phrase suggests, and neither is a distance
without an arbitrary definition. It is worth #192 knowing that before it spends a signal slot on
it: unlike authorship, this is not a case of a weak signal, it is a case of a signal with no
substrate.

### 1.6 The current Conversation is already in the prompt

Related, and it changes what "proximity" is worth: `transcriptFor` (`conversation-run-service.ts:392-408`)
renders **every complete Message of the current Conversation** into the prompt, with no window and
no truncation **[read]**. Nothing trims it. Instead, each candidate provider target that cannot
fit the assembled prompt is skipped (`:2832-2856`) **[read]**, and when no target fits the run
fails with `provider_target_incompatible` / `provider_targets_exhausted` **[read]** — so the
system's response to an overflowing current-Conversation transcript is to refuse, not to fall back
to retrieval.

So for the *current* Conversation, a proximity boost re-injects text the model has just read, at
token cost, inside a budget that is already tight. Proximity is only interesting for *other*
Conversations, and §1.5 says there is little to compute it from.

### 1.7 What ranking is *for* changes between the two corpora

For Discussions, the whole ranked list is emitted and the **context budget** does the cutting —
the assembler appends in rank order and silently `continue`s past the budget
(`discussion-context.ts:684` and `:716`, both `if (usedTokens + nextTokens > inputBudget)`)
**[read]**. Ranking is purely an ordering concern.

`search_history` is a **Tool**, and a Tool returns one string (`ToolExecutionResult.content`,
`tool-gateway.ts:47-52`) **[read]**, and the call site passes `result.content` through unchanged
(`conversation-run-service.ts:3735`) — there is no truncation step in the tool-result path
**[read]**. So the Tool itself must bound its output, which means the ranker's top-k becomes a
**membership** decision, not just an ordering one. A ranking that is "good enough to order a list" is not
automatically "good enough to decide what the model is allowed to see" — and with the score
distribution measured in §1.3(A), the cut line will frequently fall inside a tie group, i.e. be
decided by `createdAt` **[exec]**.

### 1.8 What the existing tests actually pin

`source-retrieval.test.ts` holds **9 tests**, 6 of them on `rankChunks` **[read]**. They assert:
matching items rank above non-matching ones; determinism for identical input; empty query returns
index order; ties break by index; a verbatim phrase beats a scattered match; more distinct terms
beats fewer.

None of them asserts anything that §1.3 breaks on. There is no test for length asymmetry, no test
that changes the corpus and re-checks an item's position, and no test feeds non-prose content
**[read]**. That matters for #192 specifically: #165 settled that Conversation retrieval is
asserted by **unit tests** rather than the Discussion-shaped quality corpus, and the suite those
tests would join is a behaviour lock, not a quality measure. It would pass unchanged while the
ranker did every one of the things in §1.3 **[opinion]**.

### 1.9 The thread structure this corpus does have

The ticket names "thread structure" as a candidate signal. This corpus has exactly one, and it is
one level deep **[read]**:

- A user Message is sent. `createRun` records `Run.triggerMessageId` pointing at it
  (`types.ts:339`, `conversation-run-service.ts:452`) with `memberSnapshot` = the responding
  Employees.
- The Run produces **one Message per member**, each carrying `runId` and (in a Discussion)
  `discussionId`/`discussionTurnId` (`conversation-run-service.ts:2660-2674`).

So a thread is `{trigger Message} ∪ {Messages with runId = the Run it triggered}` — a fan-out,
never nested. There is no `replyTo` on a Message and no reply-to-a-reply **[read]**.

This is precisely the shape #192's example describes: *"why is the reply ranked above the question
it answers?"* A user Message and the N Employee Messages it produced are one thread, share no
vocabulary necessarily, and a term-relevance ordering has nothing that keeps them adjacent —
`Message.runId` and `Run.triggerMessageId` are the only links, and `rankChunks` reads neither
**[read]**.

**Measured on a synthetic 243-item corpus containing that thread [exec]:** a user Message asking
*"Can we use SQLite for the store, or do we need Postgres for durability?"*, an Employee reply
that answers it with a pronoun — *"Yes, that works. It is fine for a single user, and durability
is adequate."* — and 241 unrelated messages.

| query | question's rank | answer's rank | a top-5 cut |
| --- | --- | --- | --- |
| `"sqlite postgres durability store"` | 1 | 2 | shows both — fine |
| `"what did we decide about the store"` | 1 | **122** | shows the question, **not the answer** |

The second row is the failure #192 describes, in the direction a reader notices. The answer shares
no topical noun with the query; the only term it matched (`"we"`) is in nearly every message, so
it scores `log(1 + N/df)` with `df = N`, i.e. `log 2 ≈ 0.693`, ties with the ~120 other
messages that also matched `"we"`, and is placed by the tertiary key at position 122. Nothing in the formula knows the two messages are one thread. Changing the
answer to restate the topic (*"Yes, SQLite is fine for a single-user store…"*) moves it back to
rank 2 — so what separates them is **vocabulary overlap, not relatedness** **[exec]**. The
question and the reply it answers are the closest thing this corpus has to a parent/child pair,
and the ranker cannot see the edge.

The repo's **existing convention for ordering message-shaped history is chronological**, not
recent-first: the Discussion assembler sorts selected history by
`roundNumber` then `order` (`discussion-context.ts:706`) and applied interventions by
`createdAt` ascending (`:441-443`) **[read]**. Relevance decides *what survives the cut*; time
decides the order of what did. That is worth naming, because the mechanical port of `rankChunks`
to Messages — array position as the tie-break, and `state.messages` is append-ordered
(`conversation-run-service.ts:2676`) **[read]** — reproduces exactly that convention rather than
contradicting it. The default is not arbitrary; it is the same choice the repo already made
elsewhere.

---

## Part 2 — What comparable systems do, and what is measured

Organised by the signals #192 names. A marker of **[measured-lit]** means a published result with a
named dataset and metric; **[documented]** means a vendor's own description of shipped behaviour,
which is a primary source for *what they did* but not evidence that it works; **[convention]**
means widely done with no measurement found; **[unmeasured]** means I looked and found nothing —
which is a finding, not a gap to paper over.

### 2.1 Recency and time

The single most useful comparable-system result in this document, verified against the primary
source rather than a summary of it:

**Slack Engineering, *Search at Slack*** (https://slack.engineering/search-at-slack/). Slack ships
**two** search modes. *Recent* "finds the messages that match all terms, and presents them in
reverse chronological order". *Relevant* "relaxes the age constraint and takes into account the
Lucene score of the document — how well it matches the query terms". The measured outcome, in
their words **[vendor-measured]**:

> Used about 17% of the time, Relevant search performed slightly worse than Recent according to the
> search quality metrics we measured: the number of clicks per search and the click through rate of
> the search results in the top several positions.

That is a production measurement, on a message corpus, of exactly the choice #192 is making: a
**relevance-only ordering performed worse than reverse-chronological order** on click metrics. The
corpus is the relevant part — Slack messages resemble this ticket's corpus (short, conversational,
authored, timestamped) far more than web documents do. Caveats, stated: it is click-based, not
assessed relevance; "slightly worse" is not quantified; and it is one product's users.

What Slack did next is as informative as the result. Their learned re-ranker's most significant
signals were **[documented]** — a primary source for what they shipped, and no evidence that any
individual signal helps:

> The age of the message · The Lucene score of the message with respect to the query · The
> searcher's affinity to the author of the message (… the propensity of that user to read the
> other's messages) · The priority score of the searcher's DM channel with the message author · The
> searcher's priority score for the channel the message appeared in · Whether the message author is
> the same as the searcher · Whether the message was pinned, starred or had emoji reactions · The
> propensity of searchers to click on other messages from the channel the message appeared in ·
> Aspects of the content of the message, such as word count, presence of line breaks, emoji and
> formatting.

and, notably: *"aside from the Lucene 'match' score, we have not yet incorporated any other
semantic features of the message itself."* So the winning production system put **message age
first** in a learned combination with relevance — and reported the work-graph features at **+9%
clicked searches and +27% clicks at position 1** **[vendor-measured]**, relative to the
*existing* Relevant search, not relative to Recent. **Do not attribute that uplift to recency**;
it is the uplift of the whole re-ranker over relevance-alone.

The resolution Slack shipped is the part #192 should look at hardest **[documented]**: rather than
fusing relevance and recency into one score, they ran both searches in parallel and rendered the
top 3 Relevant results **above** the normal Recent results ("Top Results"), gated by heuristics
about diversity and quantity. Both orderings were kept and layered, because they answer different
questions — *"If a user is trying to recall something that just happened, Recent is a useful
presentation of the results."*

**The origin of the recency prior, and its scope condition.** Li & Croft, *Time-Based Language
Models*, CIKM 2003 (https://ciir-publications.cs.umass.edu/getpdf.php?id=296) — read from the paper,
not a summary. They make recency a prior on document age inside a relevance model:

```
p(D / T_D) = λ · e^(−λ (T_C − T_D))
```

with `T_C` the most recent date in the collection and `T_D` the document's creation date
(eq. 3.9). Data: 36 recency queries drawn from TREC queries 301–400 over TREC vols 4 and 5,
split 20 train / 16 test; λ learned on the training split. Baselines: uniform prior, **reranking
the top 100 and top 500 solely by recency**, and a linear combination with weight α.

The measured findings, and the scope condition matters more than the numbers **[measured-lit]**:

- The paper's opening claim is not "recency helps". It is *"A type of query is identified that
  favors very recent documents"* — **recency queries**. The counter-case is stated explicitly in
  the same paragraph: *"the query 'star wars' could have most of the relevant documents in the
  Reagan era rather than in recent documents."* A recency prior is a **query-class-conditional**
  device. Nothing in this app classifies a query as a recency query; `search_history` takes one
  argument and the model authors it **[read]**.
- **"time-based language models substantially outperform reranking solely by recency"** at both
  document cut-offs. Substituting recency for relevance loses; combining them wins.
- The time-based query-likelihood model beat all three baselines; the time-based *relevance* model
  beat the first two but not the best linear combination on the test split — though on the
  training split it was **7.9% better in average precision**, and the authors attribute the
  test-set reversal to the relevance model itself underperforming on that split.
- Caveat the authors flag themselves: their collection is **time-biased** ("more documents in the
  recent past"). A corpus that grows over time has that property by construction, so the
  bias-caveat applies to this app too.

So the honest state of the recency question is not "helps" or "folklore". It is: **a recency prior
helps for queries that are about recency, must be combined with relevance rather than substituted
for it, and must not be applied to queries that are not about recency — and this app has no
mechanism that could tell the two apart.**

**Two measured results that cut the other way, and both are about message-shaped corpora.**

- **On a tweet corpus, relevance and recency were negatively correlated for most topics.**
  Carterette, Kumar, Rao & Zhu, TREC 2011
  (https://trec.nist.gov/pubs/trec20/papers/udel.microblog.pdf), on the TREC Microblog 2011
  collection: tweet relevance was negatively correlated with recency for **the majority of
  topics**, and **82% of retrieved results came from more than a day before query time**. The best
  strategy on the newest-first collection was to **threshold an ordinary relevance ranking at rank
  30** (P@30 0.323 against 0.075 for the same system returning 1,000). Their conclusion is about
  evaluation rather than about ranking, and it is the sharpest caution available: *"the hard
  recency constraint imposed in the evaluation means that automatic systems trained to this corpus
  will not find much gain from using features related to recency"* **[measured-lit]**. Read
  carefully, this says a recency-first *ordering* was beaten by a plain relevance ranking — on a
  corpus of short, timestamped, authored messages.
- **On web search, the headline recency gains are partly circular.** Dong et al., *Time is of the
  essence: improving recency ranking using Twitter data*, WWW 2010
  (https://archives.iw3c2.org/www2010/proceedings/www/p331.pdf), Bing index plus the Twitter
  firehose, 3,781 regular + 769 Twitter query–URL pairs **[measured-lit]**:

  | metric | baseline | best | relative gain |
  | --- | --- | --- | --- |
  | NDCG_demote@1 | 0.588 | 0.720 | +18.4% |
  | NDCG_demote@5 | 0.666 | 0.739 | +9.9% |
  | **NDCG_nodemo@5** — relevance only | 0.681 | 0.729 | **+6.5%** |
  | NDCF@5 — freshness only | 0.518 | 0.736 | +29.6% |

  All p<0.01, but the metric that carries the headline number **encodes recency in its labels by
  construction**; the honest relevance-only gain is **+6.5%**. The paper also contains an ablation
  that goes the wrong way for a naive reading: dropping all 454 popularity features *raised*
  freshness (NDCF@1 +7.5%) while *lowering* demoted NDCG@1 (−3.2%), which the authors attribute to
  popularity features being poorly represented for fresh URLs.

**And the default in shipped message products is chronological, not relevance.** Three, checked
against the products' own artifacts **[documented]**:

| product | default ordering | source |
| --- | --- | --- |
| Slack | two modes; *Recent* is reverse-chronological and **measured better than *Relevant*** | https://slack.engineering/search-at-slack/ |
| Discord | `sort_by` defaults to **`timestamp`**, with `relevance` as the opt-in alternative — and *"sort order is not respected when sorting by relevance"* | `discord-api-docs`, `developers/resources/message.mdx` |
| Mattermost | the open-source database path ends in `posts.SortByCreateAt()` — **creation time, not relevance** | `mattermost-server`, `post_store.go` |
| Zulip | **no ranking documented at all**; search docs cover keyword matching and filters only | https://zulip.com/help/search-for-messages |
| Notion | *"Best Matches (default)"*, with recently-edited pages higher and titles over contents | https://www.notion.com/help/search |

**Provenance of that table:** the Slack row (including the quoted measurement) I fetched and read
directly; the Discord, Mattermost, Discourse and Notion rows come from the sub-research reading the
vendors' own artifacts — API docs, help pages, and in Discourse's and Mattermost's cases the
shipped source — and I was not able to re-fetch them from here to confirm first-hand. They are
recorded as **[documented]** on that basis: each is a vendor describing its own shipped behaviour,
which is a primary source for *what they do* and no evidence at all that it works.

That is a consistent picture from the product side: for message corpora, chronological is either
the default (Discord, Mattermost, Slack's Recent) or, in Slack's case, the ordering that measured
better — and the recency signal that *is* deployed sits **inside** a relevance model (Slack's LTR,
Notion's Best Matches), not in place of one. It is also the same shape Li & Croft measured. The one
brand-new cross-cutting caution from this is Slack's: the naive reading of "add recency" is not
what any of these systems shipped.

**How production search expresses it, and what the documentation does not say.** Elasticsearch's
`function_score` decay functions
(https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-function-score-query) —
fetched and read directly **[documented]**:

- Three shapes: `gauss`, `exp`, `linear`, sharing one parameter set — `origin`, `scale`, `offset`,
  `decay`.
- `origin` is the point distance is measured from, and **for a date field the default is `now`**.
- `offset` is a dead zone: documents within it score 1.0. The docs' own worked example sets
  `origin: 2013-09-17, offset: 5d, scale: 10d, decay: 0.5` and states that documents between
  2013-09-12 and 2013-09-22 get weight 1.0 while documents 15 days from that date get 0.5.
- `decay` "defines how documents are scored at the distance given at scale… **If no decay is
  defined, documents at the distance scale will be scored 0.5.**" So the default is a half-life
  parameterisation: for `exp`, `λ = ln(decay)/scale`, which at `decay = 0.5` makes `scale`
  literally the half-life.
- **The documentation offers no criterion for choosing among the three shapes.** They are
  presented as interchangeable, with graphs, and no vendor guidance distinguishes them. Nor does
  the literature, for a better reason than neglect — see below. **The shape is a knob with no
  empirical basis** **[convention]**, and there is now measured evidence about *why*.

**The shape question has a measured answer, and the answer is that no fixed shape works.** Three
results, in descending order of strength:

- **A decay can actively hurt, and a long enough half-life is indistinguishable from no decay at
  all.** The HIT_LTRC run at TREC 2011 Microblog
  (https://trec.nist.gov/pubs/trec20/papers/HIT_LTRC.microblog.pdf), a genuine half-life sweep
  inside one system on Tweets2011 **[measured-lit]**: adding exponential decay at **τ = 7 days
  lowered MAP to 0.2727 against 0.3189 with no decay at all**. Performance reached parity only past
  τ > 40 days, and at τ = 90 it was a **statistical tie with the no-decay baseline** (0.3194 vs
  0.3189). One system and no significance testing at the short end, so treat the magnitude as
  indicative — but the direction is unambiguous, and it is the same corpus family as Carterette et
  al. above.
- **The temporal distribution of *relevant* documents is topic-dependent, so no single parametric
  shape can fit.** Lin & Efron, *Temporal Relevance Profiles for Tweet Search*, TAIA 2013
  (https://cs.uwaterloo.ca/~jimmylin/publications/Lin_Efron_TAIA2013.pdf) **[measured-lit]**: one
  topic's relevant documents cluster entirely at query time, while another's are **bimodal and
  centred days *before* the query**. They deliberately fit a **Gaussian kernel density estimate**
  rather than an exponential, on the grounds that a kernel *"carries with it no implications of
  underlying parametric forms"*. Oracle reranking using the true per-topic distribution gains
  significantly; the non-oracle version **"does not appear to be effective."** This is the
  strongest available reason to distrust every fixed-decay implementation, including
  Elasticsearch's.
- **The one explicit shape comparison in the literature is an anecdote.** A PhD dissertation
  (Keikha, USI, ca. 2011, §4.3.4 footnote 3) reports in a footnote that *"experiments showed a
  simple exponential decay to be the best temporal similarity function"* over a Gaussian kernel —
  **no numbers, no table, no test**. I record it because it is the only head-to-head shape
  comparison found at all, not because it settles anything **[opinion]**.

One thing that looks like shape evidence and is not: Kanhabua & Nørvåg (SIGIR 2011) compares six
time-aware **methods**, which differ simultaneously in content-versus-publication time,
uncertainty handling *and* decay shape, with parameters fixed rather than swept. It is not a shape
ablation and should not be cited as one **[read]**. A non-peer-reviewed 2026 preprint (Abe Diaz,
*Volatility-Driven Decay*) is the only controlled shape sweep located — sigmoid, linear,
exponential, step and softplus converging to the same performance at k ≥ 5 — and its convergence
looks like a floor effect; cite it only as "the only sweep found", never as support **[opinion]**.

Two gaps in that negative claim, flagged as gaps: the field's canonical survey (Campos, Dias,
Jorge & Jatowt, ACM CSUR 2014) is paywalled with no deposited copy, so I cannot say whether it
discusses shape; and *T-Ret: Retrieval of Temporally Relevant Documents* (CODS 2025) — whose
snippets appear to contrast exponential decay with other shapes — was unobtainable. That is the
one paper worth pulling if anyone has ACM access **[unmeasured]**.

The two knobs that *are* principled in the docs are the ones this app would need anyway: a dead
zone (`offset`) so that "recent enough" is not penalised against "most recent", and a half-life
expressed in the units you actually reason about. Both require a concrete answer to "how fast
should this app's history go stale", which nothing in the repo currently decides — and which
**cannot be measured here** for want of an eval set **[opinion]**.

Two things this does **not** settle, and I looked:

- Slack's signals are **searcher-relative** — affinity to the author, priority of the searcher's DM
  channel. This app has one user (`types.ts:317`), so several of those features have a population
  of one and cannot be reproduced. The one that could translate is affinity toward the *Employee*
  who authored a Message, which is computable from message counts — but there is nothing here that
  says it would help **[opinion]**.
- Slack's LTR is model-driven and trained on click logs. This repo has no click logs and #165
  settled the boundary at deterministic unit tests. The Slack result is therefore evidence that
  **recency is not folklore** — a top-tier production system learned it as a leading signal — while
  being no evidence at all about what *weight* it should carry here.


### 2.2 Tie-breaking is a measured mechanism — and recency was never tried in it

This is the literature that bears most directly on the central finding of Part 1. §1.3(A) measured
that the tertiary sort key decides 100% of the output for a short query and 62% for a
model-authored one. It turns out there is a formal name for that key, a measured result in its
favour, and a twelve-year gap where the obvious signal was deliberately left out.

**The framework is *lexicographic tie-breaking*, and it is measured to beat blending scores.**
Wu & Fang, *Tie breaker: A novel way of combining retrieval signals*, ICTIR 2013, with Wang, Darko
& Fang, TREC 2013 (https://trec.nist.gov/pubs/trec22/papers/udel_fang-microblog.pdf). Signals are
applied in priority order, each breaking only the ties left by the previous one; the order is
chosen by the authors' own tie-range metrics as **IDF ≻ TF ≻ NOF ≻ document length**. On Tweets2011
**[measured-lit]**:

| method | P@30 | MAP |
| --- | --- | --- |
| Okapi BM25 | 0.3782 | 0.3231 |
| Pivoted length normalisation | 0.3964 | 0.3652 |
| **Lexicographic tie-breaking** | **0.4204** | **0.3743** |

So a pure tie-break cascade beat both single-score baselines — which is the *opposite* of the
intuition that tie-breaking is a cosmetic afterthought. Applied to this repo, it says something
uncomfortable and useful: `rankChunks`'s cascade (`score` ≻ `coverage` ≻ `index`) is the right
*shape* and is not to be apologised for; what is unexamined is which signals sit in it and in what
order.

**And the signal everyone reaches for is the one nobody tested.** The four signals above are TF,
IDF, NOF and document length. **No temporal signal was tested.** The paper names
*"temporal-related signals"* as future work, its ECIR 2014 follow-up added only follower count, and
a citation-context sweep of the nine citing papers found that nobody has since added one
**[read]**. So the precise status of "use recency as a tie-breaker" — the exact thing §3.1 argues
this app is choosing by accident — is **convention, explicitly deferred in 2013 and never
done** **[convention]**. If #192 chooses it deliberately, it is not following a literature; it
would be first, on its own reasoning, with the *mechanism* validated but the *instantiation*
entirely untested.

Two adjacent results, both with caveats that matter:

- **Equal-weighted score summation of relevance and time collapsed.** A 2025 paper (Re3,
  arXiv:2509.01306) ablated a learnable per-query gate and summed semantic and temporal scores at
  equal fixed weight, collapsing hybrid R@1 from **0.742 to 0.268** (MRR 0.836 → 0.434). Its
  qualitative finding also cuts against recency-primacy: a recency-specialised retriever lifted
  many *recent but wrong* candidates, winning MRR and R@5 while losing R@1. **The authors withdrew
  this paper on 6 January 2026.** Cite it as a lead to check, never as support **[unmeasured]**.
- **The freshness-plus-relevance LTR work does not report learned per-feature weights.** Dai,
  Shokouhi & Davison, *Learning to Rank for Freshness and Relevance*, SIGIR 2011
  (https://www.microsoft.com/en-us/research/wp-content/uploads/2011/01/Dai2011.pdf), blends
  freshness and relevance through per-cluster-weighted harmonic-mean labels and uses STL
  decomposition components and Timed PageRank as temporal features. It is a **[measured-lit]**
  result on its own terms, and it **cannot** answer "did the learner give recency a small weight",
  because those weights are not published.

### 2.3 Unit of retrieval, and whether to decompose an item into parts

This is the closest measured literature to #192's "is a Brief one item or decomposed into parts?"
question, and **the headline result argues against decomposition alone** **[measured-lit]**.

**Callan, *Passage-Level Evidence in Document Retrieval*, SIGIR 1994**
(https://ciir-publications.cs.umass.edu/getpdf.php?id=105). Datasets: TIPSTER Federal Register
(46,315 documents, 38 queries), TIPSTER vols 1+2, WSJ, NPL. Metric: average precision.

| configuration | Federal Register | TIPSTER vols 1+2 |
| --- | --- | --- |
| document-level only | baseline | baseline |
| best-paragraph alone | **−2.9%** | **−27.9%** |
| document + best-paragraph combined | **+1.0%** | **+4.3%** |

Ranking by parts *instead of* the whole loses, and on the larger collection it loses badly.
Combining the two levels is what wins. Callan's stated reason is the one that applies directly to
Messages: *"chances are lower that short passages can match many of the query terms."*

That maps onto §1.3(B) of this document exactly — `rankChunks` scores by distinct query terms
matched, so a decomposed Brief fragment competes on its own (short) text and loses to any long
Message that happens to match more terms. Callan's result is the reason "combine the two levels"
is the measured option and "decompose instead" is not.

**Relevant negative results — flagged, because the obvious citations do not say what they are
usually cited for:**

- ColBERT (Khattab & Zaharia, SIGIR 2020, https://arxiv.org/abs/2004.12832) is often cited for a
  passage-level gain over document-level. **The paper contains no such comparison.** It measures
  late interaction at a fixed passage granularity on MS MARCO, an already passage-level benchmark
  (34.9 MRR@10 at 61 ms vs BERT_large 36.5 at 10,700 ms). Do not cite ColBERT for a granularity
  effect.
- The same is true of monoBERT (Nogueira & Cho, arXiv 1901.04085): BM25 16.7 → BERT_large 36.5
  MRR@10 on MS MARCO, but it is a passage reranker on a passage benchmark. No granularity ablation.
- **I found no primary source that measures conversation-level vs utterance-level *indexing* on a
  shared corpus.** TREC CAsT indexes passages throughout (2019/2020 MS MARCO passages; 2022 MS
  MARCO V2 + Wikipedia/KILT) and queries them per turn; its overviews contain no such ablation.
  MSDialog (Qu et al., SIGIR 2018) and the Ubuntu Dialogue Corpus (Lowe et al., SIGDIAL 2015) rank
  *utterances given a context* — a different question. Treat "which granularity wins for a
  conversation" as **unmeasured** **[unmeasured]**.

### 2.4 Thread structure, question-and-answer ordering, and Conversation proximity

**Does a reply need its parent? Not measured, in the sources I reached** **[unmeasured]**. The
Ubuntu Dialogue Corpus supplies up to ~10 prior turns as context but contains **no context-length
ablation**; it does not show that adding the parent turn improves retrieval of the reply. I found
no primary source for a measured "reply unintelligible without parent" result. Anyone citing one
should be asked for it.

The nearest *measured* proxy is one step removed, and it is a real result:

**TREC CAsT dependence breakdown** (Dalton et al., *TREC CAsT 2021 Overview*,
https://trec.nist.gov/pubs/trec30/papers/Overview-CAsT.pdf), NDCG@3 averaged over median-or-better
automatic runs:

| turn depends on | turns | NDCG@3 |
| --- | --- | --- |
| nothing (self-contained) | 31 | **0.513** |
| the prior query | 60 | 0.429 |
| the prior query (hard) | 16 | 0.440 |
| **prior results** | 86 | 0.393 |
| **prior results (hard)** | 17 | **0.348** |

Turns that depend on what was *returned earlier* — rather than on what was *asked earlier* — are
the hardest, and they are the majority of the tracked turns. The measured statement is about a
*query* losing its context, not about a reply losing its parent, and I am keeping that distinction
rather than eliding it.

What CAsT *does* measure about conversational context is that **carrying context into the query is
where the gain lives, and it is large**: the CAsT 2019 organizer non-conversational baseline scored
NDCG@3 **0.152** against a best automatic run of **0.436** and a best manual run of **0.589**, with
the organizers attributing the top runs to "contextual query rewriting and expansion"
(https://trec.nist.gov/pubs/trec28/papers/OVERVIEW.CAsT.pdf). CAsT 2022 isolates it: the *same*
T5+BART pipeline scores NDCG@3 **0.362** with an automatically-resolved query and **0.503** with a
manually-resolved one (https://trec.nist.gov/pubs/trec31/papers/Overview_cast.pdf). Read at face
value this bears on #192's *query* rather than its *ranking* — a model-authored `search_history`
query is the "automatic" arm of that comparison, and the literature says the automatic arm is
where the loss is.

**Does "same conversation" help? Measured in the general session setting, and the answer is
"on average yes, and unreliably"** **[measured-lit]**.

**TREC 2011 Session Track** (Kanoulas et al., https://www.khoury.northeastern.edu/home/ekanou/research/papers/mypapers/trec11draft.pdf),
nDCG@10, organizer no-session baseline **0.3007**:

| condition | mean change | runs significantly better | runs significantly worse |
| --- | --- | --- | --- |
| prior queries | +0.0383 | 29% | **27%** |
| prior queries + prior results | +0.0587 | 59% | **67%** |
| full interaction | +0.0676 | 60% | **67%** |

Session context moves the mean the right way and makes roughly a quarter to two-thirds of
systems significantly **worse**. That is the strongest available argument against treating
"same Conversation" as an automatic boost: it is a feature whose sign is not reliable across
systems, and here there is no system to tune it against.

**No product documents a same-conversation boost.** **[documented: nothing found]** I
checked: Slack, Zulip, Discourse, GitHub Discussions. Slack's engineering post *Search at Slack*
(https://slack.engineering/search-at-slack/) documents its learned re-ranker's significant
signals; message age, Lucene score, author affinity, DM-channel priority, channel priority,
author-equals-searcher, pinned/starred/reacted status, cross-channel click propensity, and content
features — but its search has no query-side conversation, so the nearest thing it documents is
*channel* affinity, not conversation proximity. Zulip documents search operators and filters and
no ranking (https://zulip.com/help/search-for-messages). Discourse documents a duplicate-term
bonus cap and demotion of closed/archived topics
(https://meta.discourse.org/t/refinements-to-search-being-tested-on-meta/254158) and no
conversation boost. GitHub documents qualifiers only
(https://docs.github.com/en/search-github/searching-on-github/searching-discussions).
Mattermost, Confluence and Notion were **not checked**. Do not attribute a ranking algorithm to
any product on the strength of a secondary write-up.

**And position within a thread dominates everything else that was measured.** Burghardt, Alsina,
Girvan, Rand & Lerman, *The myopia of crowds: Cognitive load and collective evaluation of answers
on Stack Exchange*, PLOS ONE 12(3):e0173610, 2017
(https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0173610&type=printable) —
5 years of data across **250 Stack Exchange communities**, penalised logistic regression, AUC
**[measured-lit]**:

- **Answer order (position) has the highest regression coefficient** for both voters and askers,
  and a **position-only null model converges with the full model** as the number of answers grows.
  The authors' summary: *"answer order is the dominant attribute."*
- A **"social influence"** model built from the signals a ranking would naturally reach for —
  answer score, accepted-answer flag, answerer reputation — *"tends to perform poorer than both"*
  the full model and the position-only model.
- Verbatim, on the label everyone uses: *"In the past, accepted answers have been used as a gold
  standard of answer quality… but, if askers strongly rely on heuristics like an answer's rank
  order, this puts into question whether accepted answers are the best standard."*

Two readings matter for #192, and they point in opposite directions. It independently corroborates
*Lost in the Middle* (§2.6) **in a message corpus rather than a synthetic QA task**: where an item
sits changes how it is judged. And it is a warning about the whole idea of a "good" ordering — the
position effect is large enough to contaminate the relevance labels any evaluation would use.

### 2.5 Authorship

**The corpus has no author-authority signal to generalise, and that is a property of the product
rather than of the literature.** §1.4 established it from the schema: one human user, N AI
Employees, and a `system` pseudo-author. "Author authority" means *which of many people is
trustworthy on this topic* — over a population of one human, there is nothing to rank.

**Where authorship genuinely is measured, it is the task rather than a feature — and the unit
ranked is a person.** Expert finding answers *"which person should I ask about X"*, using a
candidate's associated documents as evidence. Balog, Azzopardi & de Rijke, *Formal models for
expert finding in enterprise corpora*, SIGIR 2006
(https://staff.fnwi.uva.nl/m.derijke/wp-content/papercite-data/pdf/balog-formal-2006.pdf), on TREC
2005 Enterprise / W3C (330,037 documents, 50 topics, 1,092 candidates), metric MAP **[measured-lit]**:

| model | MAP |
| --- | --- |
| Model 1 — concatenate the candidate's documents into one profile, match the query | 0.1253 |
| Model 2 — retrieve documents for the query, then aggregate evidence per candidate | **0.1880** |

+50% relative, and the same paper family repeats it on TREC 2006 (MAP .3206 → .4660, MRR .7264 →
.9354) **[measured-lit]**. The effect is real and large — **on ranking people**. The follow-up
language-modelling paper (IP&M 45(1), 2009) also carries a useful internal negative: the
window/proximity-weighted author models gave up to +32% MAP on the *weaker* architecture (Model 1)
and **did not** beat the stronger one (Model 2), with none of those differences significant. Even
inside expert finding, a more elaborate authorship model did not help the better baseline.

**I found no primary source measuring that authorship or expertise improves the ranking of the
documents or messages themselves** **[unmeasured]**. The TREC Enterprise *document* search task did
not use author features for relevance. And query-independent authority in the standard LTR
benchmarks is *page* authority, not author authority — MSLR-WEB30K's 136 features include PageRank,
SiteRank and QualityScore among features 126–136 and **no authorship feature at all** **[read]**.

**The one clean measured ablation of an author-authority feature on a message corpus says it is
worth ~nothing.** Xu, Bennett, Hoogeveen, Lau & Baldwin, *Preferred Answer Selection in Stack
Overflow*, W-NUT @ EMNLP 2018 (https://aclanthology.org/W18-6119.pdf) — Stack Overflow threads with
≥4 answers, metric P@1. The accepted answer is the **label**, not a feature. Ablating feature
groups from the full model (P@1 .496) **[measured-lit]**:

| feature group removed | P@1 | Δ |
| --- | --- | --- |
| **Badges** — the author-authority proxy | **.499** | **+.003** |
| BasicA — dates, view counts | .497 | +.001 |
| BasicU — asker basics | .485 | −.011 |
| QTags | .442 | −.054 |
| Comments (asker interaction) | .410 | −.086 |

The authors' own words: *"The BasicQ, BasicA features, which include dates and view counts, do not
appear to be of much use. Neither does Badges, which appears to hurt the model slightly."* Ranking
by answerer reputation alone ("highest-rep") reaches P@1 .337 against random .185 — better than
chance, far below the full model, and the weight is carried by **asker–answerer interaction
structure**, not by authority counts.

**And a query-independent authority score on a social graph was measured as *influence ranking*,
not retrieval.** TwitterRank (Weng et al., WSDM 2010, https://doi.org/10.1145/1718487.1718520)
states its problem as identifying influential users and its evaluation compares influence-ranking
algorithms. **There is no retrieval task, no relevance judgement, and no MAP or NDCG.** Do not read
"PageRank on the communication graph improved ranking" as a retrieval result — in the paper the
word ranking refers to ranking *users by influence*. (I could not read that paper's evaluation
section, so even the influence metric is unverified here **[unmeasured]**.)

**What Slack documents is affinity, not authority** **[documented]**. Among its learned re-ranker's
most significant signals are *"the searcher's affinity to the author of the message (we defined
affinity of one user for another as the propensity of that user to read the other's messages)"*,
*"the priority score of the searcher's DM channel with the message author"*, and *"whether the
message author is the same as the searcher"*. The first two are **behavioural and
searcher-relative**, learned from reading logs. This app has no reading logs and one user, so they
are not merely absent but undefined **[read]**. The third translates exactly, and it is the
discourse-role distinction of §1.4 available for free on every Message.

**What I could not find, and it is the specific thing #192's example needs:** no primary source that
measures whether an answer authored by someone else should outrank the question that prompted it,
or vice versa **[unmeasured]**. The nearest thing is a *product convention*: Reddit's `qa` sort
computes `score_modifier = question_score + answer_score` — it **sums the question's and its best
answer's scores** rather than ranking one against the other (see §2.9). Treat "the author should
influence the rank" as unmeasured in the direction this app would need it.

### 2.6 Status and lifecycle as a ranking signal

#192 lists "Task or Artifact status" as a candidate. Two products publish a status signal, and they
are the closest analogues in this document to something the app could actually copy **[documented]**:

- **Discourse** demotes by topic lifecycle. Its search code carries
  `rank_sort_priorities = [["topics.archived", 0.85], ["topics.closed", 0.9]]` — *multipliers* on
  the rank score, visible in Discourse's own source (`lib/search.rb`) and described in the team's
  announcement (*Refinements to search being tested on meta*,
  https://meta.discourse.org/t/refinements-to-search-being-tested-on-meta/254158). A closed topic
  keeps 90% of its score, an archived one 85%. The announcement also states what Discourse does
  **not** do: *"we currently do not take into effect the number of incoming, internal links when
  ranking results."*
- **Notion** names its signals outright: *"**Best Matches (default)**: Shows the most relevant
  results. Pages that have been recently edited show up higher on the list, and page titles are
  more likely to show up than page contents"* (https://www.notion.com/help/search). That is a
  **recency boost plus a field weighting** (title over body), stated as product behaviour. It is
  the only vendor of the seven checked that enumerates concrete ranking signals in its user docs.

Neither is measured — both are **[convention]** supported by the vendor's own description. What
they establish is that *status demotion* and *field weighting* are things real products do, with
specific numbers attached. Nothing found here measures whether they help. Note also the asymmetry:
Discourse's statuses (closed, archived) are **terminal lifecycle states**, and this app's nearest
equivalents (`Task.status`, `Discussion.status`) are richer — `blocked`, `review`, `interrupted`
are not terminal, and there is no evidence at all about how a *transient* status should move a
rank **[opinion]**.

### 2.7 Putting metadata in front of the model

If #192 decides to surface author and timestamp in the retrieved context, this is the most
directly relevant measured result found anywhere in this ticket, and **it is a caution**:

**Zerhoudi, Granitzer & Mitrović, *Metadata, Structure, or Strategy? A Decomposition of RAG
Context Enrichment*, ECML-PKDD 2026** (https://arxiv.org/abs/2606.29645). Six benchmarks, four
models from three families, five cumulative enrichment levels, **>24,000 evaluated responses**,
metric token F1.

- **"Adding more metadata reduces accuracy on every benchmark; structure alone degrades
  reasoning."** The G1 control level — atomic JSON with *blank* metadata fields — isolates
  formatting/structure from content, and structure alone hurts **[measured-lit]**.
- Timestamps help **only** where the task reduces to date comparison: on TempLAMA (34,963
  temporal probes) the temporal-validity layer gave **+0.220 ± 0.008**, essentially all of the
  total G0→G4 gain of +0.196.
- The *same* temporal metadata on TimeQA (6,150 time-sensitive questions over Wikipedia
  paragraphs, a comprehension task) **degrades F1 by −0.045 versus G0**, because atomisation
  destroys narrative continuity **[measured-lit]**.
- Confidence metadata: "models prompted to use confidence scores comply correctly yet produce
  worse answers" — a measured gap between complying and benefiting.

The transferable claim is narrow and worth stating carefully: **do not assume that attaching
`author` and `createdAt` to a retrieved Message helps.** The measured evidence is that structural
metadata added to retrieved passages degrades comprehension on every benchmark tested, and that
temporal metadata pays only for tasks that are literally date comparisons. This does not say
"never show a timestamp"; it says the burden of proof is on adding one, and the same experiment
that would settle it (an eval set) does not exist here.

**And position in the prompt is load-bearing on its own** **[measured-lit]**: Liu et al., *Lost in
the Middle: How Language Models Use Long Contexts*, TACL 2024
(https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630). Accuracy is highest when
the answer-bearing document sits at the **very beginning** or the **very end** of the context and
degrades in the middle; GPT-3.5-Turbo's multi-document QA *"can drop by more than 20%"*, and in
the worst 20- and 30-document settings performance is **lower than with no input documents at
all**. Base (non-instruction-tuned) models show the same U-shape.

Two consequences for §3.3 of this document: the rank order is not cosmetic (the top and bottom of
the injected block are privileged positions), and "add more retrieved items" is not monotonically
good — past some point it is measurably worse than adding none. Note also the limit of the
citation: the paper tests document *position*, not conversation recency, and must not be cited for
"LLMs prefer recent context".

### 2.8 Combining several signals

**Reciprocal Rank Fusion is the measured default** **[measured-lit]**. Cormack, Clarke & Büttcher,
*Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*, SIGIR 2009
(https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf). `RRFscore(d) = Σ 1/(k + rank(d))`
with **k = 60** fixed during a pilot and not tuned afterwards. Four TREC sets plus LETOR 3,
metric MAP: it beat the best individual system by **4–5% on average** (p between 0.008 and 0.04),
beat Condorcet 7/7 (p ≈ 0.008) and CombMNZ 6/7 (p ≈ 0.04). Honest counterweights: it did **not**
beat CombMNZ on TREC 3 or on LETOR 3 (there the margin favoured CombMNZ, non-significantly,
p ≈ 0.2), and it did **not** beat the human-in-the-loop best run on TREC 9.

**Combining raw scores is fragile** **[measured-lit]**: Montague & Aslam, *Relevance Score
Normalization for Metasearch*, SIGIR 2001
(https://www.khoury.northeastern.edu/home/jaa/papers/MontagueAs01b.pdf), TREC 3/5/9, 200 random
subsets per size. Their finding is that the normalisation choice "can have a significant effect on
the overall performance", and specifically that the ubiquitous shift-to-0/scale-to-1 norm "is
highly sensitive to the max and min scores given for each query, and hence highly sensitive to
outliers."

**Flag on the composite claim.** The tidy conclusion — "use ranks, not scores, when fusing
heterogeneous signals" — is a *reasonable inference* from those two papers, **not** a single
measured result. Cormack et al. state the rank-only property as a design choice and do not run a
controlled rank-vs-well-normalised-score comparison. Treat the composite as **[convention]**
resting on two **[measured-lit]** halves.

### 2.9 The engagement half of those systems has no analogue here

Worth stating plainly, because two of the strongest comparable systems above lean on signals this
app does not have. Slack's re-ranker uses whether a message "was pinned, starred or had emoji
reactions" and the propensity of searchers to click other messages in the channel. Reddit's feed
ranking is *entirely* popularity-and-time. Verified from Reddit's own open-source implementation
(`reddit-archive/reddit`, `r2/r2/lib/db/_sorts.pyx`) **[documented]**:

```python
cpdef double _hot(long ups, long downs, double date):
    """The hot formula. Should match the equivalent function in postgres."""
    s = score(ups, downs)
    order = log10(max(abs(s), 1))
    if s > 0:
        sign = 1
    elif s < 0:
        sign = -1
    else:
        sign = 0
    seconds = date - 1134028003
    return round(sign * order + seconds / 45000, 7)
```

(verbatim, comments included; `1134028003` is the epoch second for 2005-12-08)

Hacker News, from the operator's own posted source (Paul Graham,
https://news.ycombinator.com/item?id=1781417) **[documented]**:

```arc
(= gravity* 1.8 timebase* 120 front-threshold* 1 ...)
(def frontpage-rank (s (o scorefn realscore) (o gravity gravity*))
  (* (/ (let base (- (scorefn s) 1)
          (if (> base 0) (expt base .8) base))
        (expt (/ (+ (item-age s) timebase*) 60) gravity))
     (if (no (in s!type 'story 'poll))  .8 ...)))
```

i.e. `rank ≈ (score − 1)^0.8 / ((age_minutes + 120)/60)^1.8`, with a `realscore` that subtracts
suspected sockpuppet votes and outright multipliers for buried and gagged items. Three constants —
0.8, 1.8, and a 120-minute grace window — with, again, no published derivation. Reddit and HN
together are the best-documented **convention** in this space and **neither formula has any
published retrieval evaluation that I could find** **[unmeasured]**.

A single additive scalar fusing popularity and time with **no normalisation between them**. The
exchange rate is exact and unintuitive: `45000` seconds is 12.5 hours, and `log10` gains 1 per
10× in votes, so **one order of magnitude of votes buys 12.5 hours of freshness**. The source
carries no comment justifying the constant and I found no published rationale for it, so on the
evidence available it is a **[convention]**. It is also a feed-ranking formula rather
than a retrieval one, so it should not be transplanted wholesale.

One more from the same file, and it is the closest thing found anywhere to an answer for
#192's question/reply adjacency case: Reddit's **`qa` sort** sets
`score_modifier = question_score + answer_score`, i.e. it **adds the question's score to the score
of the best answer authored by the original poster** rather than ranking one against the other
**[documented]**. That is a product convention for keeping a question and its answer adjacent, not
a measured result — but it is the only shipped mechanism located in this research that addresses
the case §1.9 measured (an answer separated from its question by 121 messages).

And in this app **there is nothing to normalise against**: `Message` has no reactions, votes,
pins, stars, bookmarks, or read receipts, and `grep -ri "reaction\|upvote"` over `src/` returns
**zero** hits **[read]** **[exec]**. So the popularity term in both systems above is not
"unavailable for now" — it does not exist in the data model, and building it would be a product
change well outside this effort. Ranking here is relevance, time, author-role, and Thread
structure, and nothing else **[read]**.

---

## Part 3 — What #192 is actually deciding

Restated as the decisions the evidence above bears on, with the evidence strength marked. Nothing
here is a recommendation for the design; it is the shape of the question after measurement.

### 3.1 The tie-break is the recency decision, not a separate one

`rankChunks` has three sort keys and the third is doing most of the work: 100% of the output for a
short query, 62% for a model-authored one **[exec]**. On Chunks that third key is document order.
On Messages it will be *something*, and if it is `createdAt` descending then recency has been
adopted as a policy for the majority of every result set — without a decay function, without a
half-life, and without anyone deciding it. #192's question *"is recency load-bearing or
folklore?"* therefore splits in two: whether a **decay term** belongs in the score, and whether
the **tertiary key** should be time. They are separable, and the second is unavoidable.

The repo's existing convention is on the record: Discussion history is ordered
`roundNumber` then `order` (`discussion-context.ts:706`) **[read]** — chronological, oldest
first — and relevance decides only what survives the budget cut. So there is precedent for either
answer, and naming which one is being chosen is the deliverable.

**The external evidence does not make this easier, and #192 should know that before it looks for a
tidy answer.** For recency-as-a-score: Slack measured relevance-only *losing* to
reverse-chronological on a message corpus and then learned message age as a leading signal
**[vendor-measured]**; Li & Croft measured a document-age prior helping **only for recency
queries** **[measured-lit]**; Carterette et al. measured relevance **anti-correlated** with
recency for most topics on a tweet corpus, with a thresholded plain relevance ranking beating the
newest-first system **[measured-lit]**. For recency-as-the-tie-break: Discord's API defaults to
`timestamp`, Mattermost's database path sorts by creation time, and Zulip documents no ranking;
Notion is the only product checked that states a recency boost, and it is inside a relevance model
**[documented]**. There is no single measured answer to import. What there is, is a consistent
*product* answer: chronological is the safe default and recency belongs inside relevance when it
appears at all.

**And if the tie-break is the answer, §2.2 sharpens it further.** Lexicographic tie-breaking is a
*measured* mechanism — a tie-break cascade beat both single-score baselines on Tweets2011
**[measured-lit]** — so the cascade structure in `rankChunks` is not the thing to fix; *which
signals are in it* is.
The signal this ticket is considering putting there, recency, is the one the tie-breaking paper
named as future work in 2013 and that nobody has since tested **[convention]**. Choosing
chronological, by contrast, matches both this repo's existing convention
(`discussion-context.ts:706`) and the shipped default of three message products (§2.1)
**[documented]**.

Over a 303-item corpus spanning ~10 months with three on-topic Messages at three ages
**[exec]**: pure relevance puts the three on-topic items at ranks 1–3, and the two candidate
tie-break policies then agree on *which* three but not on their order (newest-first:
2026‑07, 2025‑04, 2025‑11; oldest-first: 2025‑04, 2026‑07, 2025‑11), and **disagree on 302 of 303
positions overall**. Both policies put zero-coverage items at ranks 4–6; they differ in whether
those fillers are the oldest messages in the workspace or the newest. A top-5 cut therefore
returns "three relevant items plus two fillers", and the tie-break decides which fillers.

### 3.2 Whether a Brief is one item or many is a scoring decision with a measured size

Ranked as one item, a Brief carries **87% retrievable tokens that are not its content** and
outscores messages on structural key matches alone — **a single matched key already equals the
rarest term-hit the corpus can produce, and two exceed it** **[exec]**. Decomposed into parts (one
item per `facts[]` statement, per `options[]` entry, per `openQuestions[]` string) each part loses
the shared-key overhead and competes on its own text **[opinion]** — but decomposition multiplies
the corpus and changes `df` for everything (§1.3 C), and it breaks the "one Brief, one citation"
shape the evidence alias (`artifact:<id>`) currently assumes **[read]**.

**The measured literature bears on this choice directly, and points away from decomposing alone.**
Callan (SIGIR 1994) found best-passage-only retrieval **loses to whole-document retrieval** by
−2.9% (Federal Register) and −27.9% (TIPSTER vols 1+2) average precision, while *combining* the two
levels gains +1.0% and +4.3% **[measured-lit]**. His stated reason is the one that applies here:
short units "can match many of the query terms" less often. A decomposed Brief fragment is a short
unit. The evidence supports *rank both the whole Brief and its parts*, not *replace one with the
other* — and note that combining them is a second result list to fuse, which raises §2.8's
rank-fusion question.

There is a third option the measurements point at but do not settle: keep the Brief as one item
and **exclude its structural keys from tokenization** (or weight `facts`/`options` values above
keys). `rankChunks` has no field weighting and no stop-list, so either is a change to the
function, not a change to its input **[read]**.

### 3.3 A top-k cut is a membership decision, and the current ranker decides it by tie-break

`search_history` returns one string (`tool-gateway.ts:47-52`) and nothing downstream truncates it
**[read]**, so the tool bounds its own output — which makes the cut a statement about what the
model may see, not just what it sees first. Given the tie-group measurements, the cut line will
often fall inside a tie group decided by `createdAt` **[exec]**. #192 should decide whether the
cut is by rank, by score threshold, or by an explicit "these are the k most relevant, ordered
chronologically" contract — and note that a score threshold is a threshold on a
corpus-normalised quantity that will not transfer as the history grows (§1.3 C) **[opinion]**.

### 3.4 Authorship is a discourse-role signal, not an authority signal

There is one human user (`types.ts:317`, `conversation-run-service.ts:730-731`) **[read]**. So the
only authorship distinction with a non-empty population is user / employee / system, and its
useful form is "keep a question with its answers", not "trust this author more".

§2.4 supports that from the outside. Where authorship is measured to matter, it is *expert
finding*, and the unit ranked is a **person** (Balog et al., SIGIR 2006: MAP 0.1253 → 0.1880 for
the document-first model), not a message **[measured-lit]**. The one clean ablation of an
author-authority feature on a message corpus moved P@1 by **+.003 when removed** — i.e. it was
worth nothing, and might have hurt **[measured-lit]**. Slack's authorship signals are
*searcher-relative behavioural affinity*, which this app cannot compute because it has one user
**[documented]**.

So the honest reading of "should authorship participate" is: the only author feature with measured
support is an affinity signal this product cannot produce, and the authority feature it *could*
produce is the one a clean ablation measured at zero. What is left is discourse role, which is the
thing §1.9 measured the ranker failing at.

### 3.5 Conversation proximity has almost nothing to compute from

§1.5: the only declared edge between two Conversations is a shared `Group`, and Groups are written
once at creation and read nowhere else **[read]**. Any other proximity notion would be invented
for this ticket, not derived from the model. And for the *current* Conversation, proximity is
moot: it is already verbatim in the prompt (§1.6) **[read]**.

### 3.6 Task and Artifact status is a documented convention with no measurement behind it

#192 lists "Task or Artifact status" as a candidate signal, and §2.5 found exactly two products
that publish one. Discourse multiplies the rank score by **0.9 for closed topics and 0.85 for
archived ones** (`rank_sort_priorities` in `lib/search.rb`, described in the team's own
announcement); Notion states that recently-edited pages and page titles rank higher. Both are
**[convention]** supported only by the vendor's description of its own behaviour; **nothing found
here measures whether a status multiplier helps** **[unmeasured]**.

The translation is not direct. Discourse's statuses are **terminal** — a closed topic stays closed
— so the multiplier is a static penalty. The nearest fields here are `Task.status` and
`Discussion.status` (`types.ts:421`, `:644`), and several of their values are **transient**
(`blocked`, `review`, `interrupted`, `running`) **[read]**. A penalty on a transient state means a
Message's rank changes when a Task is unblocked, with no retrieval having occurred — and because
§1.3(C) established that scores are corpus-relative, that change is not local to the Task's own
Messages **[opinion]**. Nothing in the evidence says whether that is desirable; it says it is a
consequence nobody has measured.

Note also what kind of signal this would be: unlike relevance, recency, and author role, a status
multiplier is a **hand-set constant with no derivation available from the corpus**. Discourse's
0.9 and 0.85 are as unjustified as Reddit's 45000 seconds (§2.8) — and they are the only published
numbers in that family.

### 3.7 Nothing in the citation contract records why something ranked where it did

`EvidenceReference` stores `kind`, `sourceId`, optional `locator`, `excerptHash`, `retrievedAt`
(`types.ts:138-147`), and its id is a hash of the alias (`discussion-evidence.ts:45-48`)
**[read]**. There is no score, no rank, and no query. The model sees a flat
`- <alias>: <label>` list (`discussion-context.ts:517-529`) **[read]**, so any ordering rationale
is invisible to it and it cannot discount a boost it was not told about **[read]**. If #192 wants
ranking to be auditable or replayable — and the map's determinism thread suggests it does — that
is a change to the citation contract, not to the ranker.

Note also the ordering of work: recording a rank or a score on the reference would be an
`AppState` change, and the map already assigns this effort **one** schema bump, v8→v9, to land
after #173's (`CURRENT_SCHEMA_VERSION = 7` today, `src/server/store/migrations.ts:10`) **[read]**.
If ranking is to persist anything, it belongs in that bump, not a later one **[opinion]**.

### 3.8 What "asserted by unit tests" inherits

The ranker's 9 tests **[read]** do not pin any property that breaks on Messages (§1.8). If #192
routes ranking assertions into unit tests per #165, the properties worth pinning are the ones
measured here: an item's position must not change when unrelated documents are added or removed;
length must not be free; a Brief's structural keys must not count as matches; and the tie-break
must be asserted explicitly rather than left to a comparator expression **[opinion]**.

There is one further warning the evidence supports, and it is about any *quality* claim rather than
about tests. Burghardt et al. (§2.3) found answer position to be the dominant attribute of
crowd-judged answer quality across 250 communities, strong enough to put the accepted-answer label
itself in question **[measured-lit]**; Minka & Robertson found that LETOR-TDT's construction made
BM25 **anti-correlate** with relevance there, such that reversing BM25 order gave P@1 0.52 against
BM25's own 0.12, and concluded that "performance on the LETOR datasets is not an accurate guide for
choosing a ranking algorithm for a real-world problem" **[measured-lit]**. The lesson for #192 is
narrow and applies to whatever it builds next: **an ordering chosen now becomes the label an
evaluation later measures itself against**, so a ranking asserted only by unit tests will pin
behaviour without ever testing whether the behaviour is good — and building the eval set later on
data this ordering produced risks measuring the ordering rather than the corpus **[opinion]**.

### 3.9 There is already a shipped pattern for a second-stage ranker

Worth naming because #192 also has to decide *how* a non-deterministic or weighted signal gets
into the ordering, and the repo has already answered a version of that question.

`discussion-rerank.ts` implements an opt-in model re-rank on top of the deterministic baseline
**[read]**:

- the deterministic `rankChunks` order is the baseline and the fallback;
- the model sees only the **top 20** candidates (`RERANK_CANDIDATE_COUNT = 20`) and returns a
  **permutation** of those ids — it cannot add, drop, or score;
- `parseRerankOrder` validates the shape, and `isPermutation` validates the content;
- **any** failure — a throw, a timeout, a non-permutation — silently returns the baseline order;
- it is gated off entirely under `MODEL_MODE=fake` (`conversation-run-service.ts:2223`) and by a
  workspace flag (`workspace.rerankChunks`), and the resulting order is persisted on the
  Discussion as `rerankedChunkIds` (`:2363`).

That is a strong, already-tested precedent for how a weighted or model-assisted signal could enter
history ranking: **deterministic first, bounded candidate set, permutation-only, silent fallback,
explicitly gated, and the result persisted.** The `RERANK_CANDIDATE_COUNT = 20` constant is also
the closest thing in the repo to an existing answer for §3.3's "how big is the cut" — and note it
is a hard-coded 20 with no measured justification anywhere in the repo that I could find
**[read]**.

---

## Sources

### Repo — read directly

- `src/server/application/source-retrieval.ts` — `tokenize` (:3-9), `discussionRetrievalQuery` (:15-23),
  `attachedReadyChunks` (:30-46), `longestPhraseMatch` (:55-83), `rankChunks` (:92-134)
- `src/server/application/source-retrieval.test.ts` — 9 tests; 6 on `rankChunks`
- `src/server/application/discussion-rerank.ts` — the opt-in model re-rank precedent (`RERANK_CANDIDATE_COUNT = 20`, permutation-only, silent fallback)
- `src/server/application/discussion-context.ts:248-265` (rank + inject), `:441-443` and `:706` (chronological ordering), `:517-529` (flat evidence list), `:684`/`:716` (budget cut)
- `src/server/application/discussion-evidence.ts:38-48` (alias + id), `:249-320` (`availableEvidence`)
- `src/server/application/discussion-brief.ts:31-101` (`DiscussionBriefV2` strict schema)
- `src/server/application/conversation-run-service.ts` — `estimateTokenCount` (:197-199), budget planning (:301-367), `transcriptFor` (:392-408), `promptFromMessages` (:412-418), incompatible-target handling (:2832-2856), Message creation (:2660-2676)
- `src/server/application/workspace-service.ts:487-506` (Group), `:555-585` (deleteConversation cascade)
- `src/server/application/tool-gateway.ts:47-52` (`ToolExecutionResult`)
- `src/server/domain/types.ts` — `EvidenceReference` (:130-147), `Tool` (:245-289), `Group`/`Conversation`/`Message` (:294-323), `Run` (:330-356), `Task` (:409-435), `Source`/`Chunk` (:426-451), `Discussion` (:636-666), `AppState` (:696-721)
- `src/server/store/migrations.ts:10` — `CURRENT_SCHEMA_VERSION = 7`
- `docs/adr/0002-whole-workspace-retrieval-for-conversations.md`
- `CONTEXT.md` — Chunk, Retrieved chunk, Citable set, Source attachment, Evidence reference

### Prior research, in this directory

- `docs/research/pi-ai-embedding-support.md` (#91)
- `docs/research/source-retrieval-index.md` (#101)

### External — primary sources read

- Slack Engineering, *Search at Slack* — https://slack.engineering/search-at-slack/ (fetched and read; quoted verbatim)
- Li & Croft, *Time-Based Language Models*, CIKM 2003 — https://ciir-publications.cs.umass.edu/getpdf.php?id=296 (PDF fetched and read)
- Elasticsearch, *Function score query* — https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-function-score-query (fetched and read)
- Callan, *Passage-Level Evidence in Document Retrieval*, SIGIR 1994 — https://ciir-publications.cs.umass.edu/getpdf.php?id=105
- Cormack, Clarke & Büttcher, *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*, SIGIR 2009 — https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
- Montague & Aslam, *Relevance Score Normalization for Metasearch*, SIGIR 2001 — https://www.khoury.northeastern.edu/home/jaa/papers/MontagueAs01b.pdf
- Dalton et al., *CAsT 2019 / 2021 / 2022 Overviews* — https://trec.nist.gov/pubs/trec28/papers/OVERVIEW.CAsT.pdf, https://trec.nist.gov/pubs/trec30/papers/Overview-CAsT.pdf, https://trec.nist.gov/pubs/trec31/papers/Overview_cast.pdf
- Kanoulas et al., *TREC 2011 Session Track Overview* — https://www.khoury.northeastern.edu/home/ekanou/research/papers/mypapers/trec11draft.pdf
- Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, TACL 2024 — https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00638/119630
- Zerhoudi, Granitzer & Mitrović, *Metadata, Structure, or Strategy? A Decomposition of RAG Context Enrichment*, ECML-PKDD 2026 — https://arxiv.org/abs/2606.29645
- Robertson & Zaragoza, *The Probabilistic Relevance Framework: BM25 and Beyond*, FnTIR 3(4), 2009 — https://www.staff.city.ac.uk/~sbrp622/papers/foundations_bm25_review.pdf
- Zulip search docs — https://zulip.com/help/search-for-messages
- Discourse, *Refinements to search being tested on meta* — https://meta.discourse.org/t/refinements-to-search-being-tested-on-meta/254158
- GitHub Discussions search docs — https://docs.github.com/en/search-github/searching-on-github/searching-discussions
- GitHub REST search docs (best-match default) — https://docs.github.com/en/rest/search/search
- Slack help centre, *Search in Slack* (help centre documents no ranking) — https://slack.com/help/articles/202528808-Search-in-Slack
- Discord API docs, `developers/resources/message.mdx` (`sort_by` default `timestamp`) — https://github.com/discord/discord-api-docs
- Mattermost, *Search for messages* — https://docs.mattermost.com/end-user-guide/collaborate/search-for-messages.html; and `mattermost-server` `post_store.go` (`SortByCreateAt`)
- Notion, *Search* — https://www.notion.com/help/search
- Paul Graham, Hacker News `frontpage-rank` source, posted by the operator — https://news.ycombinator.com/item?id=1781417
- Reddit, `r2/r2/lib/db/_sorts.pyx` — https://github.com/reddit-archive/reddit/blob/master/r2/r2/lib/db/_sorts.pyx

### External — follow-up evidence for Part 2 §2.1–§2.2 (decay shape and tie-breaking)

- Wu & Fang, *Tie breaker: A novel way of combining retrieval signals*, ICTIR 2013, with Wang, Darko & Fang, TREC 2013 — https://trec.nist.gov/pubs/trec22/papers/udel_fang-microblog.pdf
- HIT_LTRC, TREC 2011 Microblog (half-life sweep; decay at τ=7d hurt) — https://trec.nist.gov/pubs/trec20/papers/HIT_LTRC.microblog.pdf
- Lin & Efron, *Temporal Relevance Profiles for Tweet Search*, TAIA 2013 — https://cs.uwaterloo.ca/~jimmylin/publications/Lin_Efron_TAIA2013.pdf
- Keikha, PhD dissertation (University of Lugano, ca. 2011), §4.3.4 footnote 3 — the only explicit shape comparison found; **footnote only, no numbers** — cited as an anecdote, not evidence
- Dai, Shokouhi & Davison, *Learning to Rank for Freshness and Relevance*, SIGIR 2011 — https://www.microsoft.com/en-us/research/wp-content/uploads/2011/01/Dai2011.pdf
- Kanhabua & Nørvåg, SIGIR 2011 — **cited only as a negative**: it compares six time-aware *methods*, not decay shapes, and must not be used as a shape ablation

### External — follow-up evidence for Part 2 §2.3–§2.5

- Balog, Azzopardi & de Rijke, *Formal models for expert finding in enterprise corpora*, SIGIR 2006 — https://staff.fnwi.uva.nl/m.derijke/wp-content/papercite-data/pdf/balog-formal-2006.pdf
- Balog, Azzopardi & de Rijke, *A language modeling framework for expert finding*, IP&M 45(1), 2009 — https://staff.fnwi.uva.nl/m.derijke/wp-content/papercite-data/pdf/balog-language-2009.pdf
- Xu, Bennett, Hoogeveen, Lau & Baldwin, *Preferred Answer Selection in Stack Overflow*, W-NUT @ EMNLP 2018 — https://aclanthology.org/W18-6119.pdf
- Burghardt, Alsina, Girvan, Rand & Lerman, *The myopia of crowds*, PLOS ONE 12(3):e0173610, 2017 — https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0173610&type=printable
- Weng, Lim, Jiang & He, *TwitterRank*, WSDM 2010 — https://doi.org/10.1145/1718487.1718520 (**abstract only; evaluation section not read**)
- Dong, Zhang, Kolari, Bai, Diaz, Chang, Zheng & Zha, *Time is of the essence*, WWW 2010 — https://archives.iw3c2.org/www2010/proceedings/www/p331.pdf
- Carterette, Kumar, Rao & Zhu, TREC 2011 microblog — https://trec.nist.gov/pubs/trec20/papers/udel.microblog.pdf
- Qin & Liu, *Introducing LETOR 4.0 datasets* / MSLR feature description — https://arxiv.org/abs/1306.2597
- Chapelle & Chang, *Yahoo! Learning to Rank Challenge overview*, JMLR W&CP 14, 2011 — https://proceedings.mlr.press/v14/chapelle11a/chapelle11a.pdf
- Minka & Robertson, *Selection bias in the LETOR datasets*, SIGIR 2007 workshop — https://tminka.github.io/papers/minka-letor-datasets.pdf

### Sources explicitly **not** read here

Recorded so #192 does not mistake a pointer for a finding: the TwitterRank evaluation section
(paywalled), Jeon/Croft/Lee CIKM 2005 (paywalled), Campbell et al. CIKM 2003, any measured
retrieval evaluation of Reddit's `hot` or Hacker News' `frontpage-rank` (none found), and any
primary source measuring whether an answer should outrank the question it answers (none found).
Also unread, and flagged as **gaps in a negative claim** rather than as settled absences: Campos,
Dias, Jorge & Jatowt, *Survey of Temporal Information Retrieval and Related Applications*, ACM CSUR
2014 (paywalled, no deposited copy — so I cannot say whether the field's own survey discusses decay
shape), and *T-Ret: Retrieval of Temporally Relevant Documents*, CODS 2025 (unobtainable; its
snippets appear to contrast exponential decay with other shapes, which would make it the single
most likely place a shape comparison exists). Re3 (arXiv:2509.01306) was **withdrawn by its authors
on 6 January 2026** and is cited as a lead to check, never as support. Abe Diaz, *Volatility-Driven
Decay*, is a self-released non-peer-reviewed preprint and is cited only as "the only controlled
shape sweep found".

### Measured here — and how to redo it

All **[exec]** results come from running the shipped `rankChunks`, imported directly from
`src/server/application/source-retrieval.ts`, against synthetic corpora. No reimplementation: the
`[exec]` numbers are the shipped function's output.

The procedure, so it can be repeated without the throwaway scripts (the repo's convention, per
`docs/research/tool-egress-hardening.md`, is to describe probes rather than commit them):

1. `npx tsx <script>.ts`, with the script importing `rankChunks` by **absolute path** from
   `/…/src/server/application/source-retrieval.ts`. That works without alias configuration because
   the module's only import is `import type { AppState, Chunk }`, which is erased — no
   `@/`-resolution is needed.
2. Corpora are built in memory as `Chunk[]` literals; the Message-shaped experiments add
   `author`/`runId` fields that `rankChunks` ignores (which is itself the point of §1.3 F).
3. Token counts attributed to the **repo's** estimator use `Math.ceil(new TextEncoder().encode(v).length / 3)`,
   copied from `conversation-run-service.ts:197-199`. Counts described as **words** are
   whitespace-split and are a different unit; each is labelled where it appears.

Everything is deterministic (the ranker has no randomness, clock, or I/O) and the full set was run
twice with byte-identical output. **The corpora are synthetic and there is no labelled relevance
set, so these are measurements of the ranker's behaviour, not of this product's retrieval
quality.** No effectiveness number here should be read as a quality claim.

Limitations, stated so the results are not over-read:

- The corpora are English, ASCII, and roughly uniform in message length (8–60 words), except where
  a length experiment varies it deliberately. A real Workspace has long Employee answers, code
  blocks and CJK text; the tokenizer's `\p{L}\p{N}` handling of CJK is untested here entirely.
- `df` and score magnitudes therefore reflect my corpus sizes, not a real Workspace's. The
  *shape* of each result (tie domination, length-is-free, df-is-array-relative) follows from the
  formula and does not depend on the corpus; the **specific percentages do**.
- Nothing here measures **recall**. All experiments rank a fixed set and inspect the order, which
  is exactly what `rankChunks` is for — it filters nothing. Whether the right Messages are in the
  candidate set at all is a different question and is not measured anywhere in this document.
