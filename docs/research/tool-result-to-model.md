# How a Tool result reaches the model

Every claim marked **[exec]** was verified by running code on this machine; **[read]** is a conclusion from source. The question: a `ToolGateway.execute` result is returned to `AgentTool.execute`, and from there to the model — what renders it, what truncates it, and how an error surfaces, across the provider dialects this repo supports.

The short answer: **nothing truncates it and nothing reformats it.** A Tool result is copied verbatim onto the wire in every dialect, at every size tested up to 500 000 characters. The 50 000-character `fetch_url` cap is a hand-written defensive slice with no adapter constraint behind it, and the one dialect difference that matters is not length but *who is told the result is an error* — two of the four dialects never tell the model at all.

## 1. The path

| hop | where | what it does to the result |
| --- | --- | --- |
| 1 | `RegisteredToolGateway.execute` (`tool-gateway.ts:116-171`) | produces `ToolExecutionResult` — a **single `content: string`**, plus `details`, `isError`, `errorKind` (`tool-gateway.ts:45-50`) |
| 2 | `PiModelGateway`'s `AgentTool` wrapper (`model-gateway.ts:342-354`) | wraps it as `content: [{ type: "text", text: result.content }]`, merges `errorKind` into `details`, passes `isError` through |
| 3 | `Agent` tool execution (`agent-loop.js:494-524`, `:541-552`) | `createToolResultMessage` copies `content`, `details` and `isError` onto a `role: "toolResult"` message, pushed into the transcript (`agent-loop.js:278`) |
| 4 | `transformMessages` (`transform-messages.js:120-180`) | passes the message through unchanged; only normalises the tool-call id and synthesises `"No result provided"` results for orphaned calls |
| 5 | the dialect converter (`convertMessages`) | renders the text into that dialect's tool-result slot |

The only reformatting anywhere on this path is `sanitizeSurrogates` (`utils/sanitize-unicode.js:21-25`), which **deletes** unpaired surrogates, and — for multi-block content only — joining text blocks with `"\n"`. The wrapper at hop 2 always emits exactly one text block, so the join never fires in this repo.

`ToolExecutionResult.details` is a separate channel. It rides along on the `toolResult` message and on the pi-agent-core `tool_execution_end` event, but **no dialect converter reads it** — every one of the four renders `msg.content` only. It is not model-visible by construction.

## 2. What lands on the wire

Measured by driving all four dialect converters with the same 60 000-character tool result and capturing the outgoing JSON body **[exec]**:

| provider | SDK api | request | where the text lands | chars on the wire |
| --- | --- | --- | --- | --- |
| `anthropic` | `anthropic-messages` | `POST /v1/messages` | `messages[2].content[0].content` | 60 000 |
| `openai` | `openai-responses` | `POST /responses` | `input[3].output` | 60 000 |
| `deepseek` | `openai-completions` | `POST /chat/completions` | `messages[3].content` | 60 000 |
| `google` | `google-generative-ai` | `POST /models/{id}:streamGenerateContent` | `contents[2].parts[0].functionResponse.response.output` | 60 000 |

Size ladder, chars in → chars on the wire **[exec]**:

| chars in | anthropic | openai | deepseek | google |
| --- | --- | --- | --- | --- |
| 1 000 | 1 000 | 1 000 | 1 000 | 1 000 |
| 40 000 | 40 000 | 40 000 | 40 000 | 40 000 |
| 50 000 | 50 000 | 50 000 | 50 000 | 50 000 |
| 60 000 | 60 000 | 60 000 | 60 000 | 60 000 |
| 200 000 | 200 000 | 200 000 | 200 000 | 200 000 |
| 500 000 | 500 000 | 500 000 | 500 000 | 500 000 |

Non-ASCII is preserved by code unit in all four: `"études 中文 🎯 😀 end"` (19 UTF-16 code units) arrives as 19 code units **[exec]**.

**"Three dialects" is two different wire formats, not one.** `PROVIDER_FAMILIES` (`provider-smoke.ts:96-104`) maps five providers to `openai_compatible`, but the pinned SDK splits them: `openai` uses `openai-responses`, while `deepseek`/`groq` use `openai-completions` and `mistral` uses `mistral-conversations` **[read]**. `openrouter` is genuinely two dialects in one provider — 351 of its 366 models are `openai-completions`, 15 are `anthropic-messages` **[exec]**. A per-family assumption about the wire format is wrong for `mistral` and for 15 OpenRouter models.

## 3. Error surface — the one place the dialects differ

Given a result with `isError: true` and text `EGRESS_DENIED` **[exec]**:

| dialect | what the payload carries |
| --- | --- |
| `anthropic-messages` | `{"type":"tool_result","tool_use_id":…,"content":"EGRESS_DENIED","is_error":true}` |
| `google-generative-ai` | `{"functionResponse":{"name":…,"response":{"error":"EGRESS_DENIED"}}}` — the **key changes** from `output` to `error` |
| `openai-responses` | `{"type":"function_call_output","call_id":…,"output":"EGRESS_DENIED"}` — **no error field** |
| `openai-completions` | `{"role":"tool","content":"EGRESS_DENIED","tool_call_id":…}` — **no error field** |
| `mistral-conversations` | `[tool error] EGRESS_DENIED` — an in-band 13-character **text prefix** (`mistral-conversations.js:687-703`; measured 60 027 chars vs 60 014 for the same body unflagged) |

`isError` appears nowhere in `openai-completions.js` or `openai-responses-shared.js` **[read, grep]**. So for the whole `openai_compatible` family — five of the seven shipped providers — the model is told a Tool failed **only if the Tool's own text says so**. The `errorKind` the repo threads so carefully (`model-gateway.ts:346-351`, `:413-416`, `:472-474`) is never model-visible; it is a repo-side classification that `afterToolCall` uses to set `isError`.

An empty result is worse than an error in two dialects **[exec]**:

| dialect | `content: []` or `[{type:"text",text:""}]` becomes |
| --- | --- |
| `anthropic-messages` | `"content": ""` — an empty `tool_result` body |
| `google-generative-ai` | `"response": {"output": ""}` — an empty function response |
| `openai-responses` | `"(no tool output)"` |
| `openai-completions` | `"(no tool output)"` |
| `mistral-conversations` | `"(no tool output)"` |

The Anthropic and Google messages APIs both require non-empty content, so an empty Tool result is a request the provider may reject — and in the fake gateway it is a shape that never gets exercised. This is the concrete mechanism behind the map's "never empty content" rule: it is not a stylistic preference, it is the difference between a 200 and a 400 on two of the four dialects.

## 4. Truncation: there is none

No truncation of Tool results exists anywhere on the model path, at any layer **[exec]** (size ladder above) and **[read]**: `grep -rn "truncat" ` across `pi-ai/dist` and `pi-agent-core/dist` returns only (a) provider *error body* trimming (`utils/error-body.js`), (b) the `harness/` subsystem — `harness/utils/truncate.js` (`DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 KB`) and `harness/compaction/utils.js:62` (`TOOL_RESULT_MAX_CHARS = 2000`) — which belongs to pi-agent-core's **harness tools and session compaction**, neither of which this repo uses; and (c) `agent-loop.js:255-278`, which is about *assistant* messages truncated by the output-token limit, not Tool results.

`AgentTool` is used directly by `PiModelGateway` (`model-gateway.ts:391-418`); no harness, no compaction, no session, no `truncate` call is on that path.

The 50 KB constant in `harness/utils/truncate.js` is the nearest number in the dependency to the repo's 50 000, and it is a **byte** limit in a subsystem this repo does not import. It is not the origin of the cap: the cap predates the SDK version in `package.json` being the arbiter of anything, and `harness/` is unreachable from `AgentTool`.

## 5. Was the 50 000-character `fetch_url` cap measured?

**No. It is arbitrary.** The evidence:

- The line is `tool-gateway.ts:193`: `(await response.text()).slice(0, 50_000)`. It arrived whole in `f5c2922` ("feat: execute read-only tools through skills"), the commit that introduced `tool-gateway.ts` at all — the same commit writes the fetch, the slice and the `details` in one block, with no commit-message rationale **[exec, `git show f5c2922`]**.
- `docs/research/tool-egress-hardening.md:115` records the cap only as *behaviour to preserve* when the egress transport is rewritten — "`content` truncated at 50 000 chars" — and never justifies the number. That document's subject is SSRF and redirect control; no adapter measurement appears in it or in `docs/research/attempt-attribution.md`.
- No issue, doc, ADR or comment in the repo states a reason. `grep -rn "50_000\|50,000\|50000"` over `src/`, `docs/` and `CONTEXT.md` hits the one code line and the one doc line above; `gh search issues` for result-size terms returns nothing.
- The only other place the number surfaces is issue #136's resolution, and there it is used as an *argument that the body was pointless*, not as a constraint: "A 50,000-character fetched page was being copied into state, into the browser payload, and into every backup for no reader."

There is no adapter constraint to have measured against, because — per §4 — **no adapter constrains it**.

## 6. What actually bounds a Tool result

Two real bounds, neither of them an adapter limit:

**The context window.** A Tool result is not summarised or windowed; it is spent out of the model's context. The shipped catalogs span three orders of magnitude **[exec]**: the smallest model the repo can be pointed at, `openai/gpt-3.5-turbo-0613` on OpenRouter, has a 4 095-token window; `mistral` bottoms out at 8 000; `openai` at 8 192; `google` at 65 536; `anthropic` at 200 000; `deepseek` at 1 000 000. The repo's own fallback is `DEFAULT_MODEL_CONTEXT_WINDOW = 32_768` (`discussion-context.ts:41`). At roughly four characters per token, a 40 000-character Tool result is ~10 000 tokens — about 30 % of the repo's fallback window and **more than twice the entire window** of the smallest reachable model. That is the number an implementer is really sizing against, and it is a product choice about which models are in scope, not an adapter fact.

**The unit the cap is counted in.** `.length` and `.slice` are UTF-16 code units, not characters and not bytes. A cap of 40 000 landing inside an astral-plane character (emoji, CJK extension) is cut mid-pair; `sanitizeSurrogates` then **deletes** the dangling half rather than replacing it **[exec]**: a payload built to be cut exactly at an emoji arrives as 39 999 code units with the emoji gone, not 40 000 and not 40 001-with-a-replacement-char. If the truncation notice the map specifies is to report an accurate arithmetic ("truncated N characters"), count code points or bytes — a `.length` notice will be off by one per split pair.

## 7. Two things the map's charting assumes that are not true today

**`details` never reaches `runEvents`.** The map's citable-set mechanism is "`tool_completed` where `payload.toolName === "search_sources"`, reading `details.returnedChunkIds`". But `ModelEvent.tool_completed` (`model-gateway.ts:81-89`) has no `details` field at all, and `PiModelGateway`'s `tool_execution_end` handler (`model-gateway.ts:455-476`) reads `result.details` **only to extract `errorKind`** before pushing an event that carries `{toolCallId, toolName, result, isError, errorKind}`. `conversation-run-service.ts:3619-3622` then spreads that event verbatim into the ledger. Verified end to end through the real `PiModelGateway`: a Tool whose `execute` returns `details: { returnedChunkIds: ["c1"] }` produces a `tool_completed` ModelEvent with `details === undefined` **[exec]**. The wrapper at `:342-354` does its job — the details are on the Agent's `toolResult` message and on the pi-agent-core `tool_execution_end` event — they are dropped at the last hop, in the gateway. An implementation ticket for the citable set must add `details` to `ModelEvent.tool_completed` (or carry it another way); as the code stands, the charted derivation reads a field that is never written.

**Tool results are Run-scoped in the strongest sense.** A Tool result lives only in the `Agent`'s in-memory transcript for the duration of the Run **[read]**. It is never re-injected: `PiModelGateway` passes `request.messages` only when the caller supplies them (`model-gateway.ts:356-389`), and for Conversation runs the caller passes none — `conversation-run-service.ts:2947-2959` sends a `prompt` string and `tools`, with `messages: undefined` for the non-discussion path. Nothing reconstructs a prior Run's Tool results into a later prompt. So a later Run's model cannot see what an earlier Run's `search_sources` returned, and cannot cite from it by recall — the evidence has to come from the ledger, which is exactly what the map's "derived from `runEvents`, not inherited by the next Run" rule wants, and it makes §7's first point load-bearing rather than cosmetic.

## How this was verified

Four standalone probes, all on this machine, no provider credentials and no external network — every dialect was pointed at an in-process loopback fixture that captures the request body and answers 500 (the body is already on the wire by then).

- **Agent layer** **[exec]**: pi-agent-core `Agent` driven with a scripted `streamFn` and an `AgentTool` reproducing `model-gateway.ts:342-354` exactly — confirmed the `toolResult` message carries the 60 000-character text unmodified, `details` alongside it, and `isError` on the flag.
- **Dialect layer** **[exec]**: real `Models.streamSimple` from the pinned `@earendil-works/pi-ai@0.85.1`, real catalog models, `baseUrl` overridden to the fixture — 4 dialects × sizes 1 000/40 000/50 000/60 000/200 000/500 000, plus `mistral` and both OpenRouter dialects, plus unicode, empty-content and `isError` matrices.
- **End to end through the repo** **[exec]**: the real `PiModelGateway` with `globalThis.fetch` stubbed to a valid Anthropic SSE stream, run as a throwaway vitest file under `scripts/` and deleted afterwards; the working tree is unchanged apart from this document. This is what produced the `details === undefined` finding.
- **Repository archaeology** **[exec]**: `git log -S`, `git show f5c2922`, `grep` over `src/`, `docs/`, `CONTEXT.md`, and `gh search issues` for the cap's rationale.
- **[read]** markers: `transform-messages.js`, `sanitize-unicode.js`, the four `convertMessages` implementations, `agent-loop.js:541-552`, `provider-smoke.ts:96-104`, and the `providerCatalog`/`PROVIDER_IDS` mapping.

## Verdict

| question | answer |
| --- | --- |
| Does any adapter truncate, summarise or drop a long Tool result? | **No.** Verbatim to 500 000 characters in all four dialects. |
| Is there an adapter constraint the 40 k cap must respect? | **No such constraint exists.** The 50 000 on `fetch_url` is an unexplained hand-written slice; the 40 k cap is therefore a **pure product choice**. |
| Does a Tool result carry the same fidelity across dialects? | Yes for text. **No for errors**: `anthropic` (`is_error`) and `google` (`response.error`) mark them; `openai-responses` and `openai-completions` pass plain text; `mistral` prepends `[tool error] `. |
| Can a Tool result be empty? | On `anthropic` and `google` it renders as an **empty string** where the provider expects non-empty content. The map's "never empty content" rule is load-bearing. |
| What is the real limit? | The model's context window — 4 095 tokens at the smallest reachable model against 32 768 as the repo's fallback. |
| Does `details` reach `runEvents`? | **Not today.** `ModelEvent.tool_completed` has no `details` field; the gateway drops it. |
