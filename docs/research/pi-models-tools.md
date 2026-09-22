# Pi model providers, credentials, and tool-calling hooks

Research date: 2026-09-11

## Scope and versions

This note investigates the current published Pi packages:

| Package | Version | Release artifact |
| --- | --- | --- |
| `@earendil-works/pi-ai` | `0.85.1` | [`pi-ai-0.85.1.tgz`](https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz) |
| `@earendil-works/pi-agent-core` | `0.85.1` | [`pi-agent-core-0.85.1.tgz`](https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.85.1.tgz) |

Both packages point to the same upstream monorepo, and `v0.85.1` is the matching Git tag:

- [`packages/ai/package.json`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/package.json)
- [`packages/agent/package.json`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/package.json)

There is no `packages/chat` and no published `@earendil-works/pi-chat` package at this tag. The adjacent monorepo packages are `client`, `server`, and `protocol`; the server package describes itself as experimental and says peer authentication is application policy, not part of the shipped Unix transport ([`packages/server/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/README.md)).

Both packages require Node.js `>=22.19.0` ([`pi-ai/package.json`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/package.json), [`pi-agent-core/package.json`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/package.json)).

## Executive findings

- `pi-ai` is the provider/model/auth/streaming layer. It exposes a `Models` collection that routes a selected `Model` to the provider that owns it.
- Model catalogs are generated, versioned package data. `0.85.1` contains 39 static provider catalog files and 1,354 catalog entries. `radius` is a dynamic provider with no static catalog entry.
- A model is a concrete object, not just a provider/model string. It includes provider, API protocol, base URL, context window, output limit, input modalities, reasoning support, cost, thinking-level mapping, and compatibility flags.
- Provider auth is provider-owned. Auth can come from explicit request options, an injected persistent `CredentialStore`, or provider-specific ambient sources such as environment variables, AWS profiles, or Google ADC.
- The default credential store is in memory. Persistent storage, encryption, key rotation, and workspace isolation are application-owned.
- `pi-ai` tools use TypeBox/JSON Schema. `validateToolCall()` validates and coerces arguments; tool-call arguments are streamed but are not schema-validated until `toolcall_end` and explicit validation.
- `pi-agent-core` provides a general-purpose `Agent` with `beforeToolCall` and `afterToolCall` hooks. The before hook runs after argument validation and can block execution, rewrite nothing, or return a synthetic blocked result. The after hook can replace result fields.
- `pi-agent-core` also exports an experimental durable `AgentHarness` with a hook registry, including `before_tool` and `after_tool`. A `before_tool` handler can rewrite arguments or block the call. Hook errors are fail-closed for `before_tool` and reported/ignored for `after_tool`.
- Pi does not provide a built-in human approval queue or approval record. A server-side async hook can wait for an application-owned approval decision, but the queue, persistence, authorization, and UI are application responsibilities.
- Cancellation is cooperative and signal-based. `pi-ai` propagates an `AbortSignal`; `Agent.abort()` aborts the active run; tool implementations must honor the signal they receive.
- Provider streams report failures as terminal `error` events. They do not throw after a stream has already been returned. Missing direct-auth setup can throw synchronously.
- For a browser or Next.js client, Pi warns that API keys must not be exposed. OAuth login and Amazon Bedrock are Node-only. Production browser access should use a server proxy; Pi ships the client `streamProxy()` helper but not a ready-made application authentication policy or server route implementation.

## Model selection and metadata

### Provider and model abstraction

The public `Provider` contract is responsible for provider identity, model listing, authentication, and stream dispatch. `Models` holds providers and resolves the owning provider for each model ([`src/models.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/models.ts)).

Key APIs:

```ts
const models = createModels({ credentials: store });
models.setProvider(anthropicProvider());

const model = models.getModel("anthropic", "claude-sonnet-4-6");
const providers = models.getProviders();
const anthropicModels = models.getModels("anthropic");
```

Reads are synchronous and return the last-known catalog. Dynamic providers expose an explicit asynchronous refresh:

```ts
await models.refresh({ providers: ["llamacpp"] });
const refreshed = models.getModel("llamacpp", "qwen3-30b");
```

Static built-in providers make `refresh()` a no-op. This is documented in [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#querying-models) and typed in [`src/models.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/models.ts).

### Catalog contents

The package contains 39 provider JSON catalog files. The generated manifest records `schemaVersion: 3`, a generation timestamp, and hashes for every catalog file ([`data/.manifest.json`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/providers/data/.manifest.json)).

The major catalog entries in the `0.85.1` tarball are:

| Provider catalog | Models |
| --- | ---: |
| OpenRouter | 366 |
| Vercel AI Gateway | 237 |
| Amazon Bedrock | 121 |
| Hugging Face | 71 |
| OpenCode | 68 |
| Cloudflare AI Gateway | 50 |
| Azure OpenAI Responses | 39 |
| OpenAI | 39 |
| Mistral | 32 |
| GitHub Copilot | 28 |
| Google | 22 |
| Anthropic | 14 |

The total across all 39 static files is 1,354 entries. This is package data, not a guaranteed live provider inventory; catalogs can lag upstream releases, and dynamic providers start empty until `refresh()`.

`Model` metadata includes:

```ts
{
  id,
  name,
  api,
  provider,
  baseUrl,
  reasoning,
  thinkingLevelMap,
  input: ["text", "image"],
  cost: { input, output, cacheRead, cacheWrite, tiers? },
  contextWindow,
  maxTokens,
  samplingParams?,
  headers?,
  compat?
}
```

See [`src/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts#L843) and the static catalog typing in [`src/model-catalog.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/model-catalog.ts).

Catalog values are provider-specific and should not be treated as product constants. For example, the `claude-sonnet-4-6` entry in the Anthropic catalog has `contextWindow: 1000000`, `maxTokens: 128000`, vision input, reasoning support, and a strict-tool compatibility flag. The package also exposes `getBuiltinModel()`, `getBuiltinModels()`, `getBuiltinProviders()`, and `getBuiltinModelDataGeneratedAt()` ([`src/providers/all.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/providers/all.ts)).

### Per-agent model configuration

The classic `Agent` stores a concrete `Model` in its state:

```ts
const agent = new Agent({
  initialState: {
    systemPrompt: "...",
    model,
    tools,
  },
  streamFn: models.streamSimple.bind(models),
});
```

`agent.state.model = nextModel` changes the model for future turns. `prepareNextTurn` can also replace `model` between turns. The model is passed into each provider stream call ([`src/agent.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts), [`src/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts)).

The experimental durable `AgentHarness` stores a model identity per lane and exposes `getModel()` and `setModel()` ([`harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/agent-harness.ts#L518)).

Mechanically, multiple employees can therefore share one `Models` collection while each `Agent` or harness lane has its own `Model` object. Pi does not define an employee entity, model-assignment policy, fallback policy, or credential-per-employee abstraction.

## Provider authentication and credentials

### Resolution order

Each provider owns its auth methods. The request path resolves auth in this order:

1. Explicit per-request `apiKey`, if supplied.
2. A stored credential for that provider.
3. Provider-specific ambient resolution, such as environment variables, AWS profiles, or Google ADC.

A stored credential owns the provider. If a stored credential exists, Pi does not silently fall back to an environment variable when that credential fails. This prevents a failed OAuth refresh from quietly switching accounts ([`src/auth/resolve.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/resolve.ts)).

Explicit key example:

```ts
await models.complete(model, context, {
  apiKey: "sk-explicit",
});
```

### Credential store

Applications can inject a persistent `CredentialStore`:

```ts
const models = createModels({
  credentials: myPersistentStore,
});
```

The store is keyed by `Provider.id`, with one type-tagged credential per provider. Its required operations are:

```ts
read(providerId, options?)
list(options?)
modify(providerId, fn, options?)
delete(providerId, options?)
```

`modify()` is the only write path. It is a serialized read-modify-write operation and is also used to serialize OAuth refresh. Pi ships only an in-memory default; persistent storage is application-owned ([`src/auth/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/types.ts#L65), [`src/auth/credential-store.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/credential-store.ts)).

The credential types are:

```ts
type Credential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };
```

API-key credentials can also carry provider-scoped configuration such as Cloudflare account and gateway IDs.

### Environment variables

The built-in project supports many provider environment variables. Common examples from the package README:

| Provider | Environment variable(s) |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY`, `ANTHROPIC_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` or project/location plus ADC |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` plus `AZURE_OPENAI_BASE_URL` or resource name |
| Amazon Bedrock | AWS profile, access keys, bearer token, task role, or web identity sources |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

The complete table and provider-specific details are in [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#environment-variables).

Per-request `env` values take precedence over process environment. This supports one process serving different provider configurations without global environment mutation:

```ts
await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: "...",
    CLOUDFLARE_ACCOUNT_ID: "...",
    CLOUDFLARE_GATEWAY_ID: "...",
  },
});
```

`AuthContext` is injectable and exposes `env(name)` and `fileExists(path)`. `Models.stream*()` also supports `transformHeaders`, which runs after provider auth headers, model headers, and explicit headers have been merged ([`src/auth/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/types.ts), [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#transforming-request-headers)).

### OAuth and ambient credentials

OAuth is provider-owned. When an OAuth token is close to expiry, Pi refreshes it under the credential-store lock, persists the rotated credential, and then derives request auth. The default refresh window is five minutes; refresh work has a 15-second timeout ([`src/auth/resolve.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/resolve.ts#L119)).

OAuth login flows are Node-only. Browser usage cannot run them directly. Amazon Bedrock is also Node-only. The README explicitly recommends a server-side proxy or backend service for those cases ([`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#browser-usage)).

### Auth errors

Auth failures use `ModelsError` with codes including:

- `auth`: API-key resolution or credential-store failure.
- `oauth`: token refresh or OAuth derivation failure.
- `provider`: provider-level request failure.
- `stream`: stream failure.

A failed OAuth refresh preserves the stored credential for re-login rather than silently falling back to an environment key ([`src/auth/resolve.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/resolve.ts)).

## Tools

### Tool schema

The provider-facing tool shape is:

```ts
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}
```

TypeBox is the intended schema system. `pi-ai` re-exports `Type`, `Static`, and `TSchema`, and the README warns that Google compatibility requires `StringEnum` instead of `Type.Enum` ([`src/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts#L517), [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#defining-tools)).

Tools can opt into provider-side constrained sampling:

```ts
{
  type: "json_schema",
  strict: "prefer" | "require"
}
```

They can also request provider-specific grammar modes. Support is model-dependent, and `strict: "require"` can fail when the active provider cannot honor it.

### Validation and coercion

`validateToolCall(tools, toolCall)` finds the tool and calls `validateToolArguments()`. Validation:

1. Clones the model-provided arguments.
2. Removes optional `null` values when the schema does not accept `null`.
3. Applies TypeBox conversion/coercion.
4. Compiles the TypeBox schema and validates the result.
5. Throws a formatted error containing the failing path and received arguments.

See [`src/utils/validation.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/utils/validation.ts).

Validation is not performed inside `toolcall_delta`. A `toolcall_end` event contains complete arguments, but the event documentation says the arguments are not yet schema-validated. Validation is an explicit consumer step.

### Agent tool execution

`AgentTool` extends the provider tool with:

```ts
interface AgentTool<TParameters, TDetails> extends Tool<TParameters> {
  label: string;
  prepareArguments?(args: unknown): Static<TParameters>;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
  replay?: "never" | "safe";
  executionMode?: "sequential" | "parallel";
}
```

See [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts#L387).

The classic `Agent` handles validation before executing a tool. A thrown tool error becomes a tool-result message with `isError: true`; the agent does not require tools to encode expected failures as successful content ([`packages/agent/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/README.md#error-handling)).

### Execution order

The default batch mode is `parallel`:

1. Tool calls are prepared sequentially.
2. Arguments are parsed and validated.
3. Allowed tools may execute concurrently.
4. `tool_execution_end` events are emitted in completion order.
5. Tool-result messages are persisted in assistant source order.

`sequential` executes one call at a time. A single tool with `executionMode: "sequential"` forces the entire batch to run sequentially.

If a model response stops because it hit the output-token limit, Pi does not execute its tool calls. It returns error tool results instead because the arguments may be syntactically valid but silently truncated ([`src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts)).

## Streamed tool-call events

The provider stream emits:

```text
start
text_start / text_delta / text_end
thinking_start / thinking_delta / thinking_end
toolcall_start
toolcall_delta
toolcall_end
done | error
```

Tool-call details:

- `toolcall_start` has a `contentIndex`; its initial arguments are provider-specific.
- `toolcall_delta` carries a raw JSON delta and a best-effort partial parsed `arguments` object.
- Partial arguments may be incomplete, truncated, missing fields, or contain incomplete arrays/objects.
- `toolcall_end` includes the complete call with `id`, `name`, and `arguments`, but it is not schema-validated.
- Events for different content blocks are not guaranteed to be contiguous. Consumers must use `contentIndex` rather than assuming all deltas for one block arrive together.

The event union is defined in [`src/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts#L546), and the agent-level mapping is documented in [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#complete-event-reference).

The compact frame API can encode a stream for persistence and reconstruct partial tool calls. It does not validate tool arguments; callers still need `validateToolCall()` before execution ([`src/utils/assistant-message-frame.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/utils/assistant-message-frame.ts)).

## Hooks, middleware, and approval points

There are two public hook surfaces.

### Classic `Agent` hooks

The classic `Agent` exposes:

```ts
beforeToolCall?(context, signal): Promise<{
  block?: boolean;
  reason?: string;
  terminate?: boolean;
} | undefined>;

afterToolCall?(context, signal): Promise<{
  content?;
  details?;
  isError?;
  usage?;
  terminate?;
} | undefined>;
```

The before hook runs after:

1. The tool is found.
2. `prepareArguments()` is applied.
3. Arguments pass schema validation.

Returning `{ block: true, reason }` prevents execution and creates an error tool result. The hook may be asynchronous. The hook receives the active `AbortSignal`; Pi does not cancel the hook for the application. A thrown hook error is caught by the agent and converted into an error tool result.

The after hook runs after execution and before `tool_execution_end` and the final tool-result message are emitted. Its returned fields replace the corresponding fields on the executed result. A thrown after-hook error replaces the result with an error result.

`terminate: true` only stops the automatic follow-up LLM call when every finalized tool result in that batch requests termination. A mixed batch continues normally.

See [`packages/agent/src/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts#L98) and [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts).

### Experimental durable `AgentHarness` hooks

The exported durable harness has a hook registry with:

```ts
before_tool: {
  event: { toolCallId; toolName; args };
  result?: { args?; block?: { reason; terminate? } };
}

after_tool: {
  event: { toolCallId; toolName; args; content; details?; isError; usage? };
  result?: { content?; details?; isError?; usage?; terminate? };
}
```

The registry also has `before_run`, `before_drive`, `before_run_end`, `transform_context`, `before_request`, `before_payload`, `after_response`, `before_compaction`, and `before_navigation` hooks ([`harness/agent-harness.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/agent-harness.ts#L430)).

Harness behavior established by the implementation:

- Hooks are ordered by registration.
- `before_tool` arguments replaced by a hook are validated again before execution.
- `before_tool` can block execution by returning `{ block: { reason } }`.
- A thrown or rejected `before_tool` handler is converted into a block, so the failure mode is fail-closed.
- `after_tool` patches are applied field-by-field.
- A thrown or rejected `after_tool` handler is reported as a `handler_error` and ignored.
- The tool effect does not cross the harness effect gate until the before-tool hook has returned a cleared decision.

See [`harness/hooks.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/hooks.ts) and [`harness/runtime/drive/tools.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/tools.ts).

### Approval limitation

Pi has an approval hook point, not an approval system. There is no built-in:

- pending-approval record or status machine;
- approval UI or notification channel;
- reviewer identity or authorization policy;
- durable permission grant;
- web endpoint for approve/reject;
- guarantee that an application approval queue survives process restart.

An application can make `beforeToolCall` or `before_tool` wait on an external approval promise. In the classic `Agent`, that leaves the run active. In the durable harness, a rejection or abort becomes a synthetic error result. The application must supply the approval state, persistence, authorization, and timeout semantics.

## Cancellation

### `pi-ai`

Provider request options include `signal?: AbortSignal` ([`src/types.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts#L124)).

When an in-flight request is aborted:

- The stream emits an `error` event with `reason: "aborted"` if it has started.
- The final `AssistantMessage` has `stopReason: "aborted"`.
- Partial content and usage already received remain on that message.
- Aborted messages can be added back to context and continued with a later request.

See [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#aborting-requests).

### Classic `Agent`

`agent.abort()` aborts the active run's `AbortController`. The same signal is passed to:

- context transforms;
- the provider stream;
- `beforeToolCall`;
- each tool's `execute()`;
- `afterToolCall`;
- subscribed event listeners.

Tool execution is cooperative. Pi passes the signal; a tool that ignores it can keep running. In parallel mode, queued calls observe the abort before execution, but an already-running external operation needs its own cancellation handling. `agent.waitForIdle()` resolves only after the run and awaited `agent_end` listeners finish.

### Durable `AgentHarness`

The harness uses a gate so no new effect is admitted after cancellation wins. If a tool is already admitted, the harness waits for its cancellation path and may emit an aborted or interrupted outcome. Interrupted recovery includes a durable progress snapshot marker rather than claiming the external effect had a known outcome. The internal gate is used to keep cancellation from racing with durable effect publication ([`harness/execution/effect-gate.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/execution/effect-gate.ts), [`harness/runtime/drive/tools.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/tools.ts)).

## Error behavior

### Provider streams

After a stream is returned, provider failures are encoded in the stream:

```text
start -> updates* -> error
```

Request setup can fail before generation starts:

```text
error
```

An `error` event contains a partial `AssistantMessage` with an `errorMessage`. `done` and update events are invalid before `start`. Direct API `streamSimple()` calls can throw synchronously when required auth is missing; `Models` request paths surface auth failures as stream errors ([`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#error-handling)).

Provider retries are explicit through request options such as `maxRetries` and `maxRetryDelayMs`. The retry helper treats aborts as terminal and does not retry them. Provider-requested retry delays above the configured cap fail immediately by default at 60 seconds ([`src/utils/provider-retry.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/utils/provider-retry.ts)).

### Classic `Agent`

The `StreamFn` contract says request/model/runtime failures must be encoded in the returned stream, not thrown. If the run still throws, `Agent` synthesizes an assistant failure message and emits `message_start`, `message_end`, `turn_end`, and `agent_end` rather than leaving the lifecycle unfinished ([`packages/agent/src/agent.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts)).

### Durable `AgentHarness`

Expected operation failures use typed `Result` values. Internal invariant failures can fault the harness. Harness events expose run completion as `completed`, `aborted`, or `failed`, with structured hook/event handler errors. The package documentation describes these server and harness interfaces as experimental, with no protocol compatibility guarantee.

## Server-side boundary and credential supply

### Pi's own guidance

`pi-ai` can technically run in a browser, but the README includes an explicit security warning:

> Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys.

It recommends a backend proxy for production and notes that OAuth login and Bedrock are Node-only ([`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md#browser-usage)).

Mechanically, the following can remain server-side:

- the `Models` collection;
- provider SDK requests;
- credential resolution and refresh;
- credential persistence;
- privileged tool implementations;
- approval enforcement;
- provider retry policy;
- model catalog refresh.

The browser can receive normalized stream events instead. Pi does not enforce this boundary; it requires application code to choose where `Models`, `Agent`, tools, and hooks run.

### Client proxy primitive

`pi-agent-core` exports `streamProxy()` for browser clients. It sends:

```http
POST {proxyUrl}/api/stream
Authorization: Bearer {authToken}
Content-Type: application/json
```

The body contains `model`, `context`, and serializable stream options. The client expects streamed `data:` events and reconstructs the partial assistant message locally ([`packages/agent/src/proxy.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/proxy.ts)).

Pi does not provide the `/api/stream` route, authenticate the bearer token, resolve a workspace, apply authorization, or persist credentials. Those are application responsibilities.

### Experimental Pi server

The adjacent `@earendil-works/pi-server` package is explicitly experimental. It provides routed durable Session and Agent Harness attachments and an optional Unix transport. Its README states:

- peer authentication remains application policy;
- the transport does not implement authentication;
- the real Session and Harness remain process-local;
- server and worker lifecycle are outside the public protocol.

See [`packages/server/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/README.md) and [`packages/protocol/README.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/protocol/README.md).

### Self-hosted credential supply

The supported injection points are:

```ts
createModels({
  credentials: workspaceCredentialStore,
  authContext: customAuthContext,
});
```

Or per request:

```ts
await models.complete(model, context, {
  apiKey,
  env,
  headers,
});
```

The package does not define encryption at rest, KMS integration, credential auditing, workspace partitioning, or key rotation. It does define the serialized credential mutation contract needed to avoid double-refreshing OAuth tokens.

For multiple credentials for the same provider, a separate `Models` collection or separate `CredentialStore` namespace is mechanically required because stored credentials are keyed only by provider ID.

## Open uncertainties

- The experimental durable `AgentHarness` API is exported but has little end-user documentation in the package README. Its compatibility and intended production status are not established by the published docs.
- The server package is experimental and does not implement peer authentication. A production Next.js server needs an application-defined trust boundary.
- There is no published `pi-chat` package at `v0.85.1`; any assumption that chat UI/session behavior comes from that package is unsupported by the current registry and monorepo layout.
- Pi has no built-in approval record or UI. Whether approvals are resumable, expiring, grouped, or delegated is not constrained by the SDK.
- Provider stream cancellation is cooperative. The SDK can pass and observe an abort, but it cannot stop a tool that ignores the signal.
- Model catalogs are generated release data. They can lag provider changes, and dynamic providers have no useful model list until refreshed.
- Credential-store policy is deliberately omitted. Persistence, encryption, auditing, tenant isolation, and key rotation remain unresolved implementation questions.

## Primary sources

- [`@earendil-works/pi-ai` README, v0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/README.md)
- [`@earendil-works/pi-ai` types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts)
- [`@earendil-works/pi-ai` model collection](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/models.ts)
- [`@earendil-works/pi-ai` auth contracts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/types.ts)
- [`@earendil-works/pi-ai` auth resolution](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/auth/resolve.ts)
- [`@earendil-works/pi-ai` tool validation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/utils/validation.ts)
- [`@earendil-works/pi-agent-core` README, v0.85.1](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/README.md)
- [`Agent` implementation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts)
- [`Agent` loop implementation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts)
- [`Agent` public types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts)
- [Client proxy primitive](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/proxy.ts)
- [Durable harness contract](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/agent-harness.ts)
- [Durable harness hooks](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/hooks.ts)
- [Durable harness tool execution](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/execution/tools.ts)
- [Experimental server package](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/README.md)
