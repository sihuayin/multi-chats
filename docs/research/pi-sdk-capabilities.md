# pi SDK capabilities for issue #47

Research date: 2026-09-14

## Scope and evidence

This report covers the installed package versions, the current repository adapter, and the application contracts at that boundary:

- `@earendil-works/pi-ai@0.85.1`
- `@earendil-works/pi-agent-core@0.85.1`

The repository pins both versions in `package.json:23-25`, and `npm ls` resolves both to `0.85.1`. The installed manifests also declare `0.85.1` at `node_modules/@earendil-works/pi-ai/package.json:2-3` and `node_modules/@earendil-works/pi-agent-core/package.json:2-3`. The inspected repository revision is `ee5424b017fe18ff98bf2ae7f74870cdb42e3e82`.

The distributed JavaScript includes source maps with embedded original TypeScript sources. For example, `node_modules/@earendil-works/pi-ai/dist/types.js.map` maps to `../src/types.ts`, `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js.map` maps to `../../src/api/openai-responses.ts`, and `node_modules/@earendil-works/pi-agent-core/dist/agent.js.map` maps to `../src/agent.ts`. The citations below use the installed declaration and JavaScript locations so they can be checked directly.

## Facts

### 1. Accepted request shapes

The common chat collection exposes both provider-specific and provider-neutral calls:

```ts
models.stream(model, context, options?)       // provider-specific option type
models.streamSimple(model, context, options?) // common SimpleStreamOptions
models.complete(model, context, options?)     // Promise<AssistantMessage>
models.completeSimple(model, context, options?)
```

The signatures are declared at `node_modules/@earendil-works/pi-ai/dist/models.d.ts:139-145`; `complete()` is implemented through the stream's `result()` at `node_modules/@earendil-works/pi-ai/dist/models.js:380-399`.

`Context` has a separate top-level system prompt, an ordered `Message[]`, and optional tools (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:389-393`). The common message union is `UserMessage | AssistantMessage | ToolResultMessage`; there is no system member in `Message` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:302-347`).

The native SDK-level content shapes are:

| Role | Accepted common content | Other required/available fields |
|---|---|---|
| `user` | `string` or `(TextContent \| ImageContent)[]` | `timestamp` |
| `assistant` | `(TextContent \| ThinkingContent \| ToolCall)[]` | `api`, `provider`, `model`, `usage`, `stopReason`, `timestamp`, plus optional response/diagnostic fields |
| `toolResult` | `(TextContent \| ImageContent)[]` | `toolCallId`, `toolName`, `isError`, `timestamp`, plus optional `details`, `usage`, `addedToolNames` |

Citations: `node_modules/@earendil-works/pi-ai/dist/types.d.ts:237-264` for text/image/thinking/tool-call parts, `302-320` for user/assistant messages, and `330-347` for tool results.

A compact request example:

```ts
const stream = models.streamSimple(model, {
  systemPrompt: "You are a concise assistant.",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "Read this JSON." }],
    timestamp: Date.now()
  }],
  tools: [{
    name: "lookup",
    description: "Look up a record.",
    parameters: Type.Object({ id: Type.String() })
  }]
}, { signal, maxTokens: 1024, cacheRetention: "short" });
```

`Context`, message parts, tools, and the basic options used above are defined at `node_modules/@earendil-works/pi-ai/dist/types.d.ts:106-150`, `192-195`, and `383-393`. The installed README shows the same complete request/stream flow at `node_modules/@earendil-works/pi-ai/README.md:103-183`.

`SimpleStreamOptions` adds provider-neutral `toolChoice`, `reasoning`, optional deferred execution, and custom thinking budgets. The provider-specific `stream()` options differ by API; examples are Anthropic thinking/tool-choice fields (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.d.ts:5-70`), OpenAI Responses reasoning fields (`node_modules/@earendil-works/pi-ai/dist/api/openai-responses.d.ts:3-13`), and Google thinking/tool-choice fields (`node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.d.ts:3-12`).

#### Native role and content conversion

The common adapter normalizes provider wire formats rather than sending the common shape directly:

| API | System/instruction handling | Assistant/tool-result handling | Source |
|---|---|---|---|
| Anthropic Messages | `context.systemPrompt` becomes top-level Anthropic `system` text block(s); it is not a message role. | text, thinking/redacted thinking, and `toolCall` become `tool_use`; `toolResult` becomes a `user` message containing `tool_result`. | `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:776-827`, `900-1064` |
| OpenAI Chat Completions | system prompt becomes `developer` for reasoning models when compatible, otherwise `system`. | `toolCall` becomes assistant `tool_calls`; text `toolResult` becomes role `tool`; image results are appended as a following user message when the model accepts images. | `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:881-912`, `1035-1123` |
| OpenAI Responses | system prompt becomes `developer` or `system`; user text/image become `input_text`/`input_image`; assistant messages become response output items. | calls become `function_call` or `custom_tool_call`; results become `function_call_output` or `custom_tool_call_output`. | `node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:88-127`, `129-209`, `210-226` |
| Google Generative AI | system prompt becomes `systemInstruction`. | internal `user` maps to Gemini `user`, assistant maps to `model`; text/image use `text`/`inlineData`; calls use `functionCall`; tool results use `functionResponse` and are placed in a user content item. | `node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js:279-299`, `node_modules/@earendil-works/pi-ai/dist/api/google-shared.js:97-248` |
| Mistral Conversations | system prompt is a `system` chat message. | user/assistant/tool roles are native; assistant calls become `toolCalls`; image parts use `imageUrl`; tool results can contain text and images. | `node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js:373-377`, `600-685` |

Before provider conversion, `transformMessages()` handles cross-provider replay. It drops or converts unsupported thinking, removes cross-model thought signatures, normalizes tool-call IDs, downgrades images when `model.input` lacks `image`, and repairs missing tool results (`node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:1-145`). This means a common adapter can pass a cross-provider transcript, but some native metadata is intentionally not preserved.

### 2. Streaming events and final result

The low-level result is `AssistantMessageEventStream`, an `AsyncIterable<AssistantMessageEvent>` with `result(): Promise<AssistantMessage>` (`node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts:1-20`). The stream resolves `result()` on either terminal event (`done` or `error`) at `node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js:64-75`.

The complete event union is:

- `start`
- `text_start`, `text_delta`, `text_end`
- `thinking_start`, `thinking_delta`, `thinking_end`
- `toolcall_start`, `toolcall_delta`, `toolcall_end`
- `done` with `reason` and final `message`
- `error` with `reason: "aborted" | "error"` and final `error: AssistantMessage`

The declarations are at `node_modules/@earendil-works/pi-ai/dist/types.d.ts:394-463`. `done` is restricted to `stop`, `length`, `toolUse`, or `deferred`; `error` is restricted to `aborted` or `error` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:456-463`).

Every non-terminal event carries `partial: AssistantMessage`; it is a live, shared object rather than a historical snapshot. Content events carry `contentIndex`, and starts/updates/ends for different blocks can be interleaved (`node_modules/@earendil-works/pi-ai/README.md:653-677`). The installed documentation states that `toolcall_end.toolCall` is complete but not schema-validated (`node_modules/@earendil-works/pi-ai/README.md:672`).

A typical stream usage is:

```ts
const stream = models.streamSimple(model, context, { signal });

for await (const event of stream) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
  if (event.type === "thinking_delta") { /* optional reasoning display */ }
}

const finalMessage = await stream.result();
// finalMessage.stopReason, finalMessage.content, finalMessage.usage, finalMessage.responseId?
```

The event loop and `result()` example are first-party documentation at `node_modules/@earendil-works/pi-ai/README.md:131-183`.

The final `AssistantMessage` includes mixed text/thinking/tool-call content, provider/API/model identity, optional `responseModel`, `responseId`, `providerThinkingLevel`, `diagnostics`, mandatory `usage`, `stopReason`, optional `deferred`, `errorMessage`, `rawStopReason`, `endTurn`, and `timestamp` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:307-329`).

For the low-level `Agent` used by this repository, `prompt()` itself returns `Promise<void>` and the final transcript data arrives through events (`message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`) rather than a return value (`node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:107-110`; `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:377-415`). `agent_end` is the final emitted event, but awaited subscribers still participate in run settlement (`node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:60-70`). The agent loop consumes provider stream events and emits them as `message_update` with `assistantMessageEvent` (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:176-252`).

### 3. Usage, cache, reasoning, cost, and identifiers

The mandatory unified usage shape is:

```ts
{
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cacheWrite1h?: number,
  reasoning?: number,
  totalTokens: number,
  cost: { input, output, cacheRead, cacheWrite, total }
}
```

This is declared at `node_modules/@earendil-works/pi-ai/dist/types.d.ts:265-286`. `reasoning` is a subset of `output`, not an additional output count (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:272-277`). `cacheWrite1h` is provider-specific and currently only Anthropic reports the split (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:270-271`).

Cost is calculated from `Model.cost` rates per million tokens. The implementation sums uncached input, output, cache reads, and cache writes; it applies the highest matching input-token tier and charges Anthropic 1-hour cache writes at twice base input (`node_modules/@earendil-works/pi-ai/dist/models.js:530-548`; model cost fields are at `node_modules/@earendil-works/pi-ai/dist/types.d.ts:702-736`).

Provider usage is normalized but not uniform:

- Anthropic maps input, output, cache-read, cache-write, 1-hour cache-write, and optional thinking-token details (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:407-417`, `568-592`).
- OpenAI Responses maps cached/cache-write token details and reasoning tokens; cached/write counts are subtracted from `input` (`node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:439-454`).
- OpenAI Chat Completions maps multiple compatible cached-token field spellings and reasoning-token details (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:1178-1206`).
- Google maps prompt/candidate/thought token counts, with cached content counted separately and thoughts included in `output` (`node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js:165-181`).
- Mistral maps prompt/completion/cached token counts; cache writes are set to zero (`node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js:427-437`).

Providers initialize usage to zero and may update it during streaming. Failed/aborted messages can therefore contain partial content and partial usage, as documented at `node_modules/@earendil-works/pi-ai/README.md:943-949` and implemented in each provider catch path, for example `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:506-528`.

The unified content metadata has no generic HTTP request ID field. The only common response identifier is optional `AssistantMessage.responseId` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:313-316`; README warning at `node_modules/@earendil-works/pi-ai/README.md:926`). Populated examples in the installed adapters are:

- OpenAI Responses: response id (`node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:433-438`, `477-480`).
- OpenAI Chat Completions: first chunk id (`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:372-378`).
- Anthropic: `message_start.message.id` (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:396-406`).
- Google: first non-empty `chunk.responseId` (`node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js:51-55`).
- Mistral: first non-empty stream `chunk.id` (`node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js:422-426`).

Provider HTTP response status and headers are exposed through the `onResponse` callback before the body is consumed (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:47-50`, `75-77`, `106-111`). This is the general path for provider request IDs or rate-limit headers; there is no equivalent field on `AssistantMessage`. Google's installed adapter is an exception: it does not invoke `onResponse` (`node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js:32-46`).

### 4. Token counting, context metadata, model capabilities, and structured output

`pi-ai` provides estimates, not provider tokenization:

- `estimateTextTokens()` uses `ceil(text.length / 4)`.
- Images count as `4,800` estimated characters.
- `calculateContextTokens(usage)` uses `usage.totalTokens`, falling back to the sum of input/output/cache components.
- `estimateContextTokens()` uses the latest valid assistant usage as a prefix baseline, then estimates trailing messages; before any usage exists, it also estimates system prompt and tool schemas.

Citations: `node_modules/@earendil-works/pi-ai/dist/utils/estimate.js:1-27`, `28-46`, `47-115`; declarations are at `node_modules/@earendil-works/pi-ai/dist/utils/estimate.d.ts:2-16`.

`streamSimple()` clamps `maxTokens` to `contextWindow - estimatedContextTokens - 4096` safety tokens, with a minimum of 1 (`node_modules/@earendil-works/pi-ai/dist/api/simple-options.js:1-18`). This uses the estimate above, so it is an approximation unless a recent provider usage value is available.

Model capability metadata is carried on `Model`: `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, optional `thinkingLevelMap`, supported `input` modalities (`"text" | "image"`), token cost rates/tiers, `contextWindow`, `maxTokens`, default sampling parameters, headers, and API compatibility overrides (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:716-737`).

Reasoning capability is exposed through helpers:

- `getSupportedThinkingLevels(model)` returns only `"off"` for non-reasoning models; reasoning models start from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, then apply `thinkingLevelMap` (`node_modules/@earendil-works/pi-ai/dist/models.js:550-562`).
- `clampThinkingLevel(model, level)` maps an unsupported request to the nearest supported level (`node_modules/@earendil-works/pi-ai/dist/models.js:563-581`).
- `hasApi(model, api)` is the runtime discriminator for provider-specific option typing (`node_modules/@earendil-works/pi-ai/dist/models.d.ts:182-195`).

There is no general response-format or free-text JSON-schema option in `StreamOptions` or `SimpleStreamOptions` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:106-150`, `219-229`). Structured output is modeled in two SDK-level ways:

1. Tool parameters are TypeBox schemas (`Tool.parameters`) and can opt into provider-side strict/constrained sampling through `Tool.constrainedSampling` (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:365-388`).
2. `onPayload` can replace a provider payload before dispatch (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:69-73`; README example at `node_modules/@earendil-works/pi-ai/README.md:1013-1025`).

For tool constrained sampling, `strict: "prefer"` falls back to normal tool calling where unsupported, while `strict: "require"` fails if the model/provider cannot enforce it (`node_modules/@earendil-works/pi-ai/README.md:493-509`). The strict-schema transformer rejects unsupported JSON Schema constructs, forces object properties to required, and disallows additional properties (`node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js:1-110`). The provider support set is described at `node_modules/@earendil-works/pi-ai/README.md:509`.

### 5. Errors, status/rate-limit details, timeout, cancellation, and retry hints

On the `pi-ai` side, the main entry point exports `ModelsError`, with codes:

```ts
"model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth"
```

See `node_modules/@earendil-works/pi-ai/dist/auth/resolve.d.ts:1-16`. Auth resolution wraps OAuth/API-key/store failures in this class; the implementation preserves cause details in the message (`node_modules/@earendil-works/pi-ai/dist/auth/resolve.js:3-19`, `69-130`).

Most provider failures are converted to `AssistantMessage.errorMessage` rather than exposed as a typed provider-error class. The `pi-messages` API is a separate exception: it exports `PiMessagesResponseError` with optional `code` and structured `diagnosticDetails` (`node_modules/@earendil-works/pi-ai/dist/api/pi-messages.d.ts:91-95`). The low-level `Agent` likewise throws ordinary `Error` objects for local lifecycle errors such as an already-active run or invalid continuation (`node_modules/@earendil-works/pi-agent-core/dist/agent.js:226-255`) and turns run failures into an assistant message with `stopReason: "error" | "aborted"` (`node_modules/@earendil-works/pi-agent-core/dist/agent.js:349-365`). The optional `AgentHarness` additionally exports typed `FileError`, `ExecutionError`, `CompactionError`, and `BranchSummaryError` classes with stable codes (`node_modules/@earendil-works/pi-agent-core/dist/harness/types.d.ts:114-147`; re-exports at `node_modules/@earendil-works/pi-agent-core/dist/index.d.ts:20`).

Request failures after a provider stream has been returned are not thrown to the caller. They terminate the stream with an `error` event and a final `AssistantMessage` whose `stopReason` is `"error"` or `"aborted"` and whose `errorMessage` is a string (`node_modules/@earendil-works/pi-ai/README.md:928-952`; generic lazy setup handling at `node_modules/@earendil-works/pi-ai/dist/api/lazy.js:1-45`). Provider adapters catch request/stream exceptions and perform the same conversion, for example `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js:147-158` and `node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js:217-228`.

Provider errors are normalized for display only. `normalizeProviderError()` probes `statusCode`, `status`, Bedrock metadata, response bodies, and `error.error`, truncates bodies to 4,000 characters, and returns `{ status?, body?, message, messageCarriesBody }` (`node_modules/@earendil-works/pi-ai/dist/utils/error-body.d.ts:1-24`; implementation at `node_modules/@earendil-works/pi-ai/dist/utils/error-body.js:15-117`). Provider catch paths then write a formatted string into `AssistantMessage.errorMessage`; the structured status is not retained on the final message.

Rate-limit metadata is not a field on the public result. The provider request retry helper classifies `x-should-retry`, statuses `408`, `409`, `429`, and `>=500`; honors `retry-after-ms` and `retry-after`; and otherwise uses exponential backoff (`node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js:1-44`, `75-92`). If a server-requested delay exceeds `maxRetryDelayMs`, it throws an error message containing the requested delay (`node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js:22-27`).

`StreamOptions` exposes:

- `signal?: AbortSignal`
- `timeoutMs?: number`
- `maxRetries?: number`
- `maxRetryDelayMs?: number` with documented default `60_000`
- `websocketConnectTimeoutMs?: number`

See `node_modules/@earendil-works/pi-ai/dist/types.d.ts:51-105` and `122-149`. The timeout is explicitly documented as applying only to providers/SDKs that support it (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:87-104`).

Cancellation is cooperative. The caller passes an `AbortSignal`; providers pass it to their SDK/fetch request and convert an aborted request to an `error` event with `stopReason: "aborted"` and an error message (`node_modules/@earendil-works/pi-ai/README.md:954-985`; OpenAI example at `node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js:118-127`, `147-158`). The low-level `Agent` creates its own `AbortController`, exposes `agent.signal`, and `agent.abort()` aborts the active run (`node_modules/@earendil-works/pi-agent-core/dist/agent.js:197-204`, `326-347`).

Retry hints are heuristic, not structured. `isRetryableAssistantError(message)` first rejects known quota/billing-limit text, then regex-matches `stopReason === "error"` plus text such as overloaded, rate limit, 429/5xx, timeouts, connection failures, and selected retry guidance (`node_modules/@earendil-works/pi-ai/dist/utils/retry.js:4-77`, `158-174`). There is no `retryable` or `retryAfter` property on `AssistantMessage`.

### 6. Whether retries, backoff, fallback, or failover are supplied

There are three distinct retry mechanisms in the installed packages:

1. **Initial provider request retry in `pi-ai`.** OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic, Azure Responses, and Google wrap request creation with `retryProviderRequest`/`retryGoogleRequest` (`node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js:118-127`; `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:208-217`; `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:383-392`; `node_modules/@earendil-works/pi-ai/dist/api/google-shared.js:374-399`). The helper's default `maxRetries` is `0`, so no retry occurs unless configured (`node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js:75-92`). Default maximum server-requested delay is 60 seconds (`node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js:1,22-27`). Mistral does not call this helper; its direct request path applies the abort signal and timeout but no equivalent retry loop (`node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js:158-179`).
2. **Whole assistant-call retry helper in `pi-ai`.** `retryAssistantCall()` accepts an explicit `RetryPolicy`, retries retryable returned `AssistantMessage` errors with exponential backoff `baseDelayMs * 2^(attempt-1)`, treats aborts as terminal, and has callbacks for scheduling/start/finish (`node_modules/@earendil-works/pi-ai/dist/utils/retry.d.ts:1-42`; implementation at `node_modules/@earendil-works/pi-ai/dist/utils/retry.js:96-156`).
3. **Durable retry in `AgentHarness`.** The optional harness accepts a `RetryPolicy` (`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:617-635`), defaults it to `{ enabled: true, maxRetries: 3, baseDelayMs: 1000 }` (`node_modules/@earendil-works/pi-agent-core/dist/harness/config.js:1-1`), and emits `retry_scheduled`, `retry_start`, and `retry_end` events (`node_modules/@earendil-works/pi-agent-core/dist/harness/agent-harness.d.ts:261-280`). Retry waits use exponential delay (`node_modules/@earendil-works/pi-agent-core/dist/harness/runtime/drive/retry.js:1-7`).

The low-level `Agent` class used by the current repository does not automatically retry failed assistant turns. It stops the loop on `stopReason === "error"` or `"aborted"` and emits `turn_end` followed by `agent_end` (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:122-128`). The documented recovery mechanism is `agent.continue()` from the existing user/tool-result context (`node_modules/@earendil-works/pi-agent-core/README.md:152-161`). Its API requires the raw last message to be user or tool-result; if it is an error assistant message, `continue()` throws unless a steering or follow-up message was queued (`node_modules/@earendil-works/pi-agent-core/dist/agent.d.ts:107-111`; `node_modules/@earendil-works/pi-agent-core/dist/agent.js:233-255`). A `prepareNextTurn` hook can change model/context only after a completed turn; it is invoked on subsequent loop iterations, not in the error-return path (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:89-101`, `148-157`; hook type at `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:111-119`, `193-198`).

There is no generic cross-provider failover in `Models`: `stream()` and `streamSimple()` require and dispatch to the provider that owns the selected model (`node_modules/@earendil-works/pi-ai/dist/models.js:351-399`). Provider-specific routing exists:

- Anthropic server-side refusal fallback can be requested with `compat.allowedFallbackModels`; the adapter sends `fallbacks` to Anthropic and tracks the returned model's cost (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:604-610`; `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:401-417`, `890-893`). The adapter explicitly rejects a mid-output model fallback after output has begun (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:419-424`).
- OpenRouter routing options include `allow_fallbacks`, ordered providers, only/ignore lists, and routing constraints (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:623-690`). This is upstream routing inside OpenRouter, not `Models` failover.
- OpenAI Codex can fall back from WebSocket transport to SSE, which is transport fallback rather than provider failover (`node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js:220-244`).

### 7. Provider differences relevant to a common adapter

The repository's provider registry registers seven providers: OpenAI, Anthropic, Google, OpenRouter, DeepSeek, Groq, and Mistral (`src/server/adapters/model/provider-registry.ts:23-31`; `src/lib/provider-catalog.ts:1-23`). The installed provider factories map those names to different APIs:

| Provider | Installed API adapter | Notable common-contract difference |
|---|---|---|
| OpenAI | `openai-responses` (`node_modules/@earendil-works/pi-ai/dist/providers/openai.js:1-13`) | Responses-specific output items, developer/system role selection, response id, output-token reasoning/cache details. |
| Anthropic | `anthropic-messages` (`node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js:39-54`) | Top-level system blocks; thinking signatures; explicit prompt-cache controls; optional server-side fallbacks. |
| Google | `google-generative-ai` (`node_modules/@earendil-works/pi-ai/dist/providers/google.js:5-13`) | `systemInstruction`; Gemini `user`/`model` roles and `functionCall`/`functionResponse`; custom `fetch` is rejected (`node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js:32-46`). The adapter does not pass `timeoutMs` into `generateContentStream` (`node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js:41-46`). |
| OpenRouter | Both `anthropic-messages` and `openai-completions` depending on model (`node_modules/@earendil-works/pi-ai/dist/providers/openrouter.js:1-25`) | Model metadata controls developer-role support, thinking format, routing, and strict-tool capability. |
| DeepSeek | `openai-completions` (`node_modules/@earendil-works/pi-ai/dist/providers/deepseek.js:1-13`) | Catalog entries use compatibility flags such as `max_tokens`, no developer role, DeepSeek thinking format, and reasoning-content replay (`node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json:1`). |
| Groq | `openai-completions` (`node_modules/@earendil-works/pi-ai/dist/providers/groq.js:1-13`) | OpenAI-compatible chat mapping with model-specific image/reasoning support (`node_modules/@earendil-works/pi-ai/dist/providers/data/groq.json:1`). |
| Mistral | `mistral-conversations` (`node_modules/@earendil-works/pi-ai/dist/providers/mistral.js:1-13`) | Native chat payload names; native `toolCalls`; direct `fetch` request path; default request timeout is 60 seconds (`node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js:158-179`). |

Important cross-provider differences:

- System role is not common. Anthropic and Google use separate top-level system fields; OpenAI can use `developer` or `system`; Mistral uses `system`.
- Tool result serialization is not common. Anthropic uses `tool_result` inside a user message; OpenAI Chat uses role `tool`; OpenAI Responses uses `function_call_output`; Google uses `functionResponse`; Mistral uses role `tool`.
- Tool-call IDs may require normalization across providers. OpenAI Responses IDs can contain `|` and exceed 64/450-character provider limits; conversion code has provider-specific normalization (`node_modules/@earendil-works/pi-ai/dist/api/transform-messages.d.ts:1-7`; `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:881-907`; `node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js:69-87`).
- Image handling depends on `model.input`. Unsupported user/tool images are replaced with text placeholders or omitted (`node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:1-27`).
- Reasoning metadata is not portable. Same-model thinking signatures may be replayed; cross-provider/model thinking is converted to text or dropped, and tool-call thought signatures are removed (`node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js:70-117`; Google-specific replay at `node_modules/@earendil-works/pi-ai/dist/api/google-shared.js:137-188`).
- Prompt caching is provider-specific. Common options are `cacheRetention` and `sessionId`; Anthropic-style cache controls, OpenAI prompt-cache fields, Google cache reads, and Mistral affinity are implemented differently (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:127-149`; OpenAI cache handling at `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js:807-879`; Mistral affinity at `node_modules/@earendil-works/pi-ai/dist/api/mistral-conversations.js:191-204`).
- OpenAI-compatible behavior varies materially through `OpenAICompletionsCompat`, including developer role, reasoning format, usage-in-streaming, finish reason, tool-result name, assistant-after-tool-result insertion, max-token field, cache format, and session-affinity headers (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:468-532`).
- Response IDs, reasoning usage, cache fields, and usage itself are not equally available from all providers. The unified fields are optional or zero/undefined when the provider does not report them (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:265-286`; provider extraction sites cited in section 3).

## Current repository adapter implications

These are factual observations about the present boundary, not architecture decisions.

### Application request surface

`ModelRequest` currently contains one provider, credential, model ID, system prompt, one prompt string, tools, and an optional signal (`src/server/application/model-gateway.ts:20-28`). It has no array of native system/user/assistant/tool-result messages, model history, reasoning level, cache/session option, timeout, retry limit, or output-schema parameter.

`ModelEvent` currently exposes only:

- `text_delta`
- `text_completed`
- `tool_started`
- `tool_completed`
- `error` with optional `kind: "retryable" | "terminal" | "cancelled"`

See `src/server/application/model-gateway.ts:30-51`. The contract has no reasoning events, tool-call argument deltas, `stopReason`, usage/cost, cache counts, provider response ID, request ID, provider status, rate-limit delay, or final message metadata.

### `PiModelGateway` mapping

The adapter creates a new `Models` collection and resolves one selected model (`src/server/adapters/model/model-gateway.ts:186-197`; factory selection at `src/server/adapters/model/provider-registry.ts:55-65`).

It creates one low-level `Agent` per run with:

- system prompt and selected model;
- tools converted from JSON Schema via `Type.Unsafe`;
- `models.streamSimple.bind(models)`;
- sequential tool execution;
- `afterToolCall` mapping the repository's tool `errorKind` into `isError`;
- `maxRetryDelayMs: 2_000`.

See `src/server/adapters/model/model-gateway.ts:210-244`.

The subscription forwards only `text_delta` updates (`src/server/adapters/model/model-gateway.ts:246-257`). It contains handling for `update.type === "error"`, but the installed agent loop does not emit a terminal provider error as `message_update`; it consumes the terminal stream event, emits the final `message_end`, and returns that message (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:207-239`). The normal model-error path therefore reaches `agent_end` without the adapter examining `finalMessage.stopReason` or `errorMessage`; `agent_end` emits a synthetic `text_completed` containing accumulated text (`src/server/adapters/model/model-gateway.ts:291-296`). The adapter does not subscribe to `thinking_*` or `toolcall_*` events, does not read the final `AssistantMessage`, and does not forward usage, cost, `stopReason`, `responseId`, or diagnostics.

The repository tool result contract itself is text-only (`content: string`) plus optional details/error kind (`src/server/application/tool-gateway.ts:44-60`), while `pi-ai` tool results support text and image blocks (`node_modules/@earendil-works/pi-ai/dist/types.d.ts:330-346`). The adapter therefore has an internal image-content path only after converting repository tool results to SDK text blocks (`src/server/adapters/model/model-gateway.ts:216-227`).

Provider cancellation is requested by calling `agent.abort()` when `request.signal` aborts (`src/server/adapters/model/model-gateway.ts:298-300`). As with model errors, the low-level agent converts the aborted provider result into a final assistant message and ends the run; the adapter does not inspect that final `stopReason`. Only an exception thrown by `agent.prompt()` itself is mapped to a terminal `ModelEvent` in the adapter's catch (`src/server/adapters/model/model-gateway.ts:302-311`). If `request.signal` is already aborted, the adapter calls `agent.abort()` before `agent.prompt()` creates an active run; `Agent.abort()` only aborts `activeRun`, so that pre-aborted call has no active run to cancel (`src/server/adapters/model/model-gateway.ts:298-302`; `node_modules/@earendil-works/pi-agent-core/dist/agent.js:197-204`, `226-232`).

### Application retry and structured-output handling

The conversation runner performs at most two attempts, retries only when `event.kind === "retryable"` and no output was produced, and waits a fixed 250 ms (`src/server/application/conversation-run-service.ts:1044-1116`). `PiModelGateway` has no normal path that emits `kind: "retryable"`; standard provider failures are converted by the low-level agent into terminal assistant messages rather than adapter error events (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:207-239`; `src/server/adapters/model/model-gateway.ts:246-311`).

Discussion payload validation is outside the SDK: the application extracts a JSON object from text and validates it with Zod (`src/server/application/structured-output.ts:1-14`; `src/server/application/discussion-turn-payload.ts:1-48`). No schema is currently passed through `ModelRequest` to the SDK's `Tool.constrainedSampling` or a generic provider response-format option.

Provider listing exposes only `id`, `name`, `contextWindow`, `maxTokens`, and `reasoning` (`src/server/application/provider-gateway.ts:8-14`; `src/server/adapters/model/provider-registry.ts:68-80`). It does not expose `input` modalities, thinking-level map, cost rates/tiers, API kind, or provider compatibility settings from the SDK `Model`.

## Unresolved unknowns

- The installed code establishes the normalization rules, but no live requests were made. Actual provider support for usage details, cache counts, reasoning counts, response IDs, strict schemas, and rate-limit headers can vary by account, model snapshot, gateway, and payload.
- Provider-specific request-ID and rate-limit header names are not normalized by `pi-ai`. They are observable only through `onResponse`; the current adapter does not register that callback. The installed packages do not enumerate a cross-provider header contract.
- `timeoutMs` is documented as provider-dependent. OpenAI/Anthropic request paths forward it, Google's adapter does not pass it into the installed `generateContentStream` call, and Mistral has a separate 60-second default timeout. The effective timeout behavior for each installed upstream SDK was not tested against live endpoints.
- The installed built-in model catalogs are snapshots. Runtime model availability and metadata can differ after provider refreshes or API changes; this report describes the installed `0.85.1` catalogs and code only.
- `AgentHarness` supplies configurable durable retry/backoff and retry lifecycle events, but the current adapter uses low-level `Agent`. The repository has no current-harness integration or test coverage to establish how its persistence and retry semantics would interact with application runs.
- There is no generic free-text structured-output API in `StreamOptions`; provider-native response schemas could be injected through `onPayload`, but their exact fields and compatibility were not separately verified against each current provider in this pass.
- `responseId` semantics differ by provider (message ID, response ID, or streaming chunk ID), and the package explicitly says it is optional. No installed source establishes it as a uniform request ID.
