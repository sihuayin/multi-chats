# Pi session persistence, streaming, and server topology

Research date: 2026-09-11

Primary Pi source baseline: tag `v0.85.1`, commit
`d981de1229ef899957bbe968bc8dcda02a21f477`.

Package source baseline: the published `0.85.1` packages listed below.
The only exception is the legacy SQLite package, which is published as
`0.83.0` and was renamed at `0.84.0`.

This document reports what the current packages do. It does not select an
application architecture.

## Short version

- Pi has two distinct execution layers.
  - `Agent` is a stateful, event-emitting runtime whose transcript is only in
    process memory unless the application persists it.
  - `Session` plus `AgentHarness` is the durable runtime. `Session` stores a
    parent-linked entry tree and `AgentHarness` stores operation state,
    retry/wait state, queues, and configuration in that session.
- A `Session` can contain multiple named lanes. Each lane has its own
  transcript tip, model, thinking level, active tool names, queue, and at most
  one active operation. One harness instance owns one session and exposes all
  of its lanes.
- Pi ships memory, JSONL, and SQLite session implementations. The SQLite
  implementation is a separate Node package using `node:sqlite`.
- Low-level agent events and durable harness events are rich, typed, in-process
  events. They are not automatically the browser wire protocol.
- The experimental Pi server transports opaque Chord service calls over
  length-prefixed CBOR. Model events, transcripts, and tool events must be
  exposed as application-defined services and subscriptions.
- Pi's built-in server transport is Unix-domain sockets only. The client API is
  transport-neutral and explicitly allows WebSocket, Unix socket, or another
  ordered byte transport, but WebSocket support is not implemented by these
  packages.
- The current packages have no distributed worker, queue, lease, or cross-process
  session writer. The host application must route one session to one writable
  process at a time.
- Pi packages require Node `>=22.19.0`. Next.js 16.3.4 requires Node `>=20.9.0`,
  so a deployment must use Node 22.19 or newer to run both.
- Next.js Route Handlers can return `ReadableStream` responses and default to
  the Node.js runtime. The Edge runtime is deprecated. A browser cannot directly
  consume Pi's built-in Unix transport or CBOR protocol without an application
  bridge.
- There is no published `@earendil-works/pi-chat` package as of the research
  date. There is an official `@earendil-works/pi-web-ui` package, but it embeds
  `Agent` in the browser and persists browser-side state in IndexedDB. It is not
  the durable `Session` / `AgentHarness` stack.

## Package reality at this revision

Published versions checked:

- [`@earendil-works/pi-agent-core@0.85.1`](https://www.npmjs.com/package/@earendil-works/pi-agent-core/v/0.85.1)
- [`@earendil-works/pi-protocol@0.85.1`](https://www.npmjs.com/package/@earendil-works/pi-protocol/v/0.85.1)
- [`@earendil-works/pi-client@0.85.1`](https://www.npmjs.com/package/@earendil-works/pi-client/v/0.85.1)
- [`@earendil-works/pi-server@0.85.1`](https://www.npmjs.com/package/@earendil-works/pi-server/v/0.85.1)
- [`@earendil-works/pi-session-backend-sqlite-node@0.85.1`](https://www.npmjs.com/package/@earendil-works/pi-session-backend-sqlite-node/v/0.85.1)
- [`@earendil-works/pi-storage-sqlite-node@0.83.0`](https://www.npmjs.com/package/@earendil-works/pi-storage-sqlite-node/v/0.83.0)
- [`@earendil-works/pi-web-ui@0.75.3`](https://www.npmjs.com/package/@earendil-works/pi-web-ui/v/0.75.3)

Package naming notes:

- The SQLite package changelog says it was renamed from
  `@earendil-works/pi-storage-sqlite-node` to
  `@earendil-works/pi-session-backend-sqlite-node` in `0.84.0`, with a new v4
  lane-based schema. The old package is therefore not the current backend.
  See the
  [SQLite changelog](https://github.com/earendil-works/pi/blob/v0.85.1/packages/session-backends/sqlite-node/CHANGELOG.md).
- `@earendil-works/pi-chat` returns 404 from npm. The official web package is
  `@earendil-works/pi-web-ui`; the separate `pi-web-ui` package is a
  third-party application around the Pi coding agent, not the same package.

## Execution layers

### 1. Stateful `Agent`

`Agent` is described as the stateful wrapper around the low-level agent loop.
It owns an in-memory transcript, emits lifecycle events, executes tools, and
supports steering and follow-up queues.

Sources:

- [Agent README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/README.md)
- [Agent API](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts)
- [Agent event types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts)

Facts:

- `AgentOptions` accepts a `sessionId`, but that ID is documented as a provider
  cache identifier. It does not itself persist the transcript.
- `Agent.prompt()` and `Agent.continue()` reject a second concurrent run while
  `activeRun` exists.
- `Agent.abort()` aborts the current in-process `AbortController`.
- `Agent.waitForIdle()` settles after `agent_end` listeners finish.
- `Agent` persists nothing automatically. An application-owned subscriber must
  flush state if it uses `Agent` directly.

This layer is suitable for browser-local or other in-process usage, but it
does not by itself answer server durability, ownership, or recovery.

### 2. Durable `Session` plus `AgentHarness`

The current durable stack is exported from
`@earendil-works/pi-agent-core/harness/session` and the main agent package.

Sources:

- [Session types and persistence interfaces](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/types.ts)
- [Session implementation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/session.ts)
- [AgentHarness API](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/agent-harness.ts)
- [Harness runtime creation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/harness.ts)

Facts:

- A `Session` is a parent-linked tree of entries. Entry types are:
  `message`, `compaction`, `branch_summary`, and `custom`.
- Message entries contain an `AgentMessage`. Custom entries contain
  application-defined JSON plus a `customType`.
- The session API includes branch creation, branch scans, labels, names,
  scalar values, list values, usage rows, mutations, and stats.
- A session mutation is an exclusive, keyless barrier within that session
  implementation. A `SessionMutation` permits exactly zero or one commit
  attempt. There is no distributed lock in this interface.
- `AgentHarness.create()` opens a session, restores all configured lanes, and
  returns an `open` array for operations that were already active when the
  process attached. Restoration does not start provider, tool, hook, or timer
  effects.
- A `Session` can have multiple named lanes. A lane is a conversation branch
  with its own tip, configuration, queues, and operation lifecycle.
- Each lane's persisted configuration includes provider/model ID, thinking
  level, and active tool names.
- A lane selects active names from the harness-global tool registry. Tool
  implementations themselves are not lane-local.
- Tools, resources, system prompt, stream options, retry policy, compaction
  settings, and message projection are configured at the harness level and are
  shared by the lanes of that harness instance.

Implication for a multi-employee product:

- Per-employee model, thinking level, and active tool set can be represented by
  lane configuration.
- Per-employee system prompts or disjoint skill/tool sets cannot all be varied
  independently inside one harness instance without additional application
  projection or separate harness/session instances, because those are
  harness-level options.

## Persistence APIs and backends

### Repository contract

`SessionRepo` exposes:

```ts
create(options, context): Promise<Session>
open(metadata, context): Promise<Session>
list(options | undefined, context): Promise<Metadata[]>
delete(metadata, context): Promise<void>
fork(source, options, context): Promise<Session>
```

`Session` exposes:

```ts
getEntry(id)
getEntries(ids)
getStats()
findEntries(query)
findEntry(query)
branch(name)
createBranch(name, at)
beginMutation()
mutate(callback)
getValue(address)
setValue(address, next)
deleteValue(address)
scanValues(prefix)
appendList(address, element)
readList(address, options)
deleteList(address)
getName()
setName(name)
getLabel(targetId)
setLabel(targetId, label)
close()
```

`Branch` exposes `getTipId()`, `findEntries()`, `findEntry()`,
`appendMessage()`, and `appendCustomEntry()`.

Source:

- [Session and repository interfaces](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/types.ts)

### Fork semantics

`fork()` supports:

- `scope: "branch"`: copy one path from a configured source lane, optionally
  stopping before or including a selected entry.
- `scope: "tree"`: copy the whole conversation tree and every branch tip.

Configured lanes copy their configuration and receive fresh idle state.
Operation state, pending state, result records, and usage state are excluded.

This gives Pi-native branch and conversation-copy primitives. It does not
define application-level semantics for employees, groups, or tasks.

### Memory backend

`MemorySessionRepo` stores sessions only in process memory. It is useful for
tests, ephemeral demos, and explicitly non-durable work.

Source:

- [Memory session repository](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/memory.ts)

### JSONL backend

`JsonlSessionRepo` is in the core package and writes one JSONL file per
session. The repository takes an injected `FileSystem`, a `sessionsRoot`, and
an optional clock.

Facts:

- The file format version is 4 and the storage version is 1.
- The default path shape is
  `<sessionsRoot>/--<encoded-cwd>--/<timestamp>_<encoded-id>.jsonl`.
- The repository prevents concurrent local opens of the same session key.
- The repository close implementation currently contains a TODO about final
  ownership semantics and resolves without closing all open session handles.
- The file format supports legacy v3 reads and upgrade behavior.

Sources:

- [JSONL repository](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/jsonl/repo.ts)
- [JSONL storage](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/jsonl/storage.ts)
- [JSONL types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/jsonl/types.ts)

The package documentation does not provide a cross-process ownership or lock
protocol for JSONL. The host must ensure one writer.

### SQLite backend

`@earendil-works/pi-session-backend-sqlite-node` uses the Node built-in
`node:sqlite` module through a `SqliteDatabaseFactory`.

Facts:

- The default layout creates one SQLite file per session under a directory.
- `databasePath` can instead use one supported shared SQLite container with
  rows scoped by `session_id`.
- Every durable row is scoped with `session_id`.
- Authoritative tables are `entries`, `scalar_values`, `list_values`, and
  `usage_ledger`; `branch_entries`, `branch_meta`, and session statistics are
  maintained projections/caches.
- Writable connections use WAL and `busy_timeout = 5000`.
- Listing is read-only and best-effort.
- The repository rejects overlapping local create/open/fork/delete ownership
  for one session ID.
- The package README explicitly states that it implements no cross-process
  lease, lock, fence, heartbeat, or takeover. One writable owner per session is
  a host lifecycle responsibility.
- The host must close a writer before deleting the session.
- The package does not export search or FTS.

Sources:

- [SQLite backend README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/session-backends/sqlite-node/README.md)
- [SQLite repository](https://github.com/earendil-works/pi/blob/v0.85.1/packages/session-backends/sqlite-node/src/sqlite/repo.ts)
- [SQLite initial schema](https://github.com/earendil-works/pi/blob/v0.85.1/packages/session-backends/sqlite-node/src/sqlite/migrations/001_initial.sql)
- [Node `node:sqlite` documentation](https://nodejs.org/api/sqlite.html)

`node:sqlite` was added in Node 22.5. It was experimental through earlier
versions and is a release candidate in Node 25.7. Pi's package engine requires
Node 22.19 or later, so the exact Node minor/patch and stability level should be
treated as a deployment constraint.

## Streaming and event formats

### Low-level `Agent` events

`Agent.subscribe()` receives:

- `agent_start`
- `turn_start`
- `message_start`
- `message_update`, with an `AssistantMessageEvent` and partial message
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `turn_end`
- `agent_end`

`message_update` carries provider/model stream deltas. The Pi agent loop
forwards `text_delta`, `toolcall_delta`, `toolcall_end`, `done`, and `error`
style assistant events. Tool updates and endings are separate events.

In parallel tool mode:

- tool calls are prepared sequentially;
- allowed tools execute concurrently;
- `tool_execution_end` is emitted in completion order;
- persisted tool-result messages remain in assistant source order.

Source:

- [Agent event definitions](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/types.ts)
- [Agent loop event flow](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent-loop.ts)

### Durable `AgentHarness` events

The harness event vocabulary is broader and operation-oriented:

- Lifecycle: `run_start`, `run_resume`, `run_suspend`, `run_end`,
  `operation_abort`, `fault`, `handler_error`
- Turns: `turn_start`, `turn_end`
- Retry: `retry_scheduled`, `retry_start`, `retry_end`
- Messages: `message_start`, `message_update`, `message_end`, `entry_added`
- Tools: `tool_start`, `tool_update`, `tool_end`
- State: `queue_update`, `value_update`, `config_update`, `lane_created`,
  `usage`
- Structural work: `compaction_start`, `compaction_end`,
  `navigation_start`, `navigation_end`

Events include lane and operation IDs where relevant. A lane snapshot can
include the current streaming assistant message, running tools, retry timing,
deferred state, queues, transcript, statistics, and fault state.

Sources:

- [Harness event union](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/agent-harness.ts)
- [Harness event bus](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/events.ts)

### Wire protocol

`@earendil-works/pi-protocol` does not carry a built-in transcript or model
stream schema. Protocol version 8 defines:

- a client/server version handshake;
- server and session request targets;
- correlated request/response envelopes;
- an explicit `cancel` envelope;
- opaque JSON service-call payloads;
- opaque subscription updates;
- out-of-band attachment changes.

Each frame is a four-byte unsigned big-endian payload length followed by one
definite-length CBOR item. Default limits are 16 MiB per CBOR payload/frame,
1,000,000 collection entries, and 64 nested levels. The protocol README says it
is experimental and provides no compatibility guarantees.

The protocol owner is not responsible for the semantics of transcript,
model, plugin, or application payloads. `@earendil-works/chord` defines the
service-call, catalogue, subscription, and error semantics carried in the
opaque payloads.

Sources:

- [Protocol README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/protocol/README.md)
- [Protocol message schemas](https://github.com/earendil-works/pi/blob/v0.85.1/packages/protocol/src/protocol.ts)
- [Framing](https://github.com/earendil-works/pi/blob/v0.85.1/packages/protocol/src/framing.ts)

Consequence:

- Streaming model output to a browser requires an application-defined service
  contract and transport. The protocol only provides request correlation,
  cancellation, subscription updates, and attachment routing.

## Cancellation, retry, resume, and ownership

### Cancellation

Low-level `Agent`:

- `abort()` aborts the active `AbortController`.
- Tool execution, provider streaming, and callbacks receive the signal.
- The loop converts abort or provider failure into an assistant message with
  stop reason `aborted` or `error`.

Durable harness:

- `requestAbort(operationId)` first commits a durable `cancel_requested`
  marker.
- It removes queued steer/follow-up messages and returns their payloads to the
  caller.
- If a drive is active, it tells that drive's gate to cancel future effect
  admission and signals the active abort path.
- `abort()` waits for the operation to settle and returns the removed queues.
- A running external effect is not force-killed or rolled back. Its recovery
  behavior depends on durability and replay policy.

Server/client:

- A client abort sends a protocol `cancel` envelope for the request ID.
- The server aborts the request's `AbortController`.
- This is RPC cancellation, not a rollback guarantee. Durable operation
  cancellation is the responsibility of the application service that receives
  the aborted context.

Sources:

- [Low-level agent abort path](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/agent.ts)
- [Durable lane cancellation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/lane.ts)
- [Server cancellation handling](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/src/server.ts)
- [Client request cancellation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/client/src/client.ts)

### Retry

The durable harness has a retry policy with maximum attempts and base delay.
It persists a `assistant.retry_wait` operation state and emits:

- `retry_scheduled`
- `retry_start`
- `retry_end`

The retry wait records the next attempt and `notBefore`. A high-level
`prompt()` waits for retries. A lower-level caller can use `accept()` plus
`drive()` with `waitForRetry: false` to receive a `waiting` outcome and resume
later.

Provider request options also include `maxRetries` and `maxRetryDelayMs`.

Sources:

- [Harness retry state](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/types.ts)
- [Retry scheduling](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/retry.ts)
- [Assistant response handling](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/response.ts)

### Resume after process loss

`AgentHarness.create()` reads the durable session and returns `open` operation
descriptors. It does not start provider calls, tool effects, hooks, or timers.
The host must create the harness and explicitly drive or resume the operation.

Recovery behavior:

- An `assistant.effect_pending` operation is settled from the bounded committed
  stream-frame prefix without making another provider request.
- If the provider outcome was not committed, the recovered assistant message
  is marked as an error with an explicit unknown external outcome warning.
- A tool effect in `effect_pending` is not blindly replayed by default.
- Safe replay happens only when both the persisted tool intent and the current
  tool implementation declare `replay: "safe"`.
- Otherwise, the tool result is synthesized from the last durable progress
  snapshot and marked as interrupted with unknown external outcome.

Sources:

- [Harness restoration](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/restore.ts)
- [Assistant recovery](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/recovery.ts)
- [Tool recovery and replay](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/drive/tools.ts)

### Ownership

Ownership is process-local unless the host adds coordination:

- A lane permits one active operation. A second run receives `LaneBusy`.
- A session mutation line serializes mutations inside one open session object.
- SQLite rejects overlapping local ownership for a session ID.
- SQLite explicitly does not implement cross-process lease, lock, fence,
  heartbeat, or takeover.
- JSONL rejects local duplicate opens but does not document a cross-process
  writer protocol.
- The server router keeps one hosted worker/session handle per server process
  for a session ID, but the host's `openSession()` callback owns worker
  acquisition and lifecycle.

Implication:

- Multiple Node or Next.js instances cannot safely write the same Pi session
  without an application-level ownership mechanism or session-to-worker
  routing.

## Mapping employees, groups, conversations, and tasks to Pi

Pi provides:

- Sessions as durable containers and branch trees.
- Lanes as independent conversation branches with lane-local model, thinking,
  and active tool configuration.
- Forking at a branch entry or whole-tree scope.
- Custom entries and values for application-defined data.
- Event and snapshot APIs for observation.

Pi does not provide:

- Employee, group, conversation, task, artifact, or approval domain objects.
- A built-in many-to-many membership model.
- A distributed router from an application conversation to one session owner.
- Cross-session memory.
- A built-in way to merge several independently running lane transcripts into
  one coherent model context.

Several mappings are technically possible:

| Mapping | Pi-native fit | Main constraint |
| --- | --- | --- |
| One session per application conversation, one lane per employee | Strong isolation between employee transcripts; per-lane model/tool names | Harness-level system prompt, skills, resources, and tool implementations are shared unless the application projects context |
| One session per application conversation, one lane for the whole group | Simple shared transcript and one active model config at a time | Employees do not have independent transcripts or concurrent lane runs |
| One session per employee, application conversation references multiple sessions | Per-employee harness configuration is straightforward | The application must fan out, order, and assemble context/results; cross-session context is not defined by Pi |
| One session per task or delegation, forked from conversation state | Uses tree/branch fork semantics naturally | Conversation continuity and result promotion remain application concerns |

Source:

- [Lane configuration and session APIs](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/session/types.ts)
- [Harness lane construction](https://github.com/earendil-works/pi/blob/v0.85.1/packages/agent/src/harness/runtime/harness.ts)

## Database, worker, queue, and long-running process requirements

There is no single Pi deployment requirement. The requirements depend on which
layer and guarantees are used.

| Requirement | When it becomes necessary |
| --- | --- |
| No database | A browser-local `Agent` or `MemorySessionRepo` with accepted process-loss risk |
| Durable filesystem | JSONL sessions, one file per session, with one writer |
| SQLite | Durable SQLite sessions, either one file per session or one shared container; writer ownership remains host-managed |
| Other DB | An application's employee/group/task/artifact model, or shared coordination across instances; this is outside Pi |
| Long-running Node process | Active provider streams, in-process agent/tool callbacks, retry timers, and deferred work |
| Worker process | To keep agent execution out of request/render processes and to own session lifecycle |
| Queue or scheduler | To survive serverless request termination or to distribute durable work across workers |
| Routing or lease layer | To ensure one writer per session when more than one process can receive work |
| Event bridge | To expose Pi events to browsers over SSE, WebSocket, NDJSON, or another application protocol |

Pi's own server package does not run the worker fleet for the application.
Its README states that server and worker lifecycle is managed outside the
public Pi protocol. The replaceable application server owns demand and worker
retirement decisions.

Source:

- [Pi server README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/README.md)

Server details:

- `ServerHost` requires `resolveSession()` and `openSession()`.
- A resolved session is opened into a process-local `RoutedSessionHandle`.
- Multiple presentation attachments can point at one hosted session.
- Disconnecting a presentation rejects its local responses and releases its
  attachment only after admitted service calls settle.
- `RoutedSessionHandle.terminated` lets the host invalidate a crashed worker
  handle.

Source:

- [Server host and routing types](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/src/types.ts)

## Client, server, and transport topology

### Server package

- The package describes itself as experimental.
- Its built-in transports are Unix-domain sockets.
- `ServerListener` is a general byte-connection interface, so an application
  can add another transport.
- Peer authentication is application policy and is not implemented by the
  Unix transport.
- Session/Session-service routing is opaque. The server validates routes but
  does not load application business contracts.

Sources:

- [Server README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/README.md)
- [Server listener interface](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/src/listener.ts)
- [Unix listener](https://github.com/earendil-works/pi/blob/v0.85.1/packages/server/src/transports/unix/listener.ts)

### Client package

- The client is transport-neutral.
- Its README explicitly says a transport factory can connect with WebSocket,
  Unix socket, or another ordered byte transport.
- The package only provides the Unix transport implementation.
- On disconnect, pending requests reject locally. Accepted work may still
  complete remotely.
- The client does not reconnect or replay requests automatically. After a
  disconnect, the application must reconnect, reattach, and repeat only
  operations known to be safe.

Sources:

- [Client README](https://github.com/earendil-works/pi/blob/v0.85.1/packages/client/README.md)
- [Client transport interface](https://github.com/earendil-works/pi/blob/v0.85.1/packages/client/src/transport.ts)
- [Client lifecycle](https://github.com/earendil-works/pi/blob/v0.85.1/packages/client/src/client.ts)

### Browser boundary

The browser cannot directly use the built-in Unix socket transport. It also
does not consume the Pi CBOR protocol without an application adapter. Therefore
an application must choose one of these broad shapes:

- Keep `Agent` entirely in the browser, as the official web UI does.
- Run the durable stack in Node and expose an application API or event stream
  from that Node process.
- Run a separate Pi server and bridge its Unix/CBOR transport through a Node
  web layer.

The official `@earendil-works/pi-web-ui` README describes the first shape:
`ChatPanel` wraps an in-browser `Agent`, and `SessionsStore` is backed by
IndexedDB. That is useful for browser-local chat, but it does not provide the
durable `Session` plus `AgentHarness` guarantees.

Source:

- [Official web UI README](https://www.npmjs.com/package/@earendil-works/pi-web-ui/v/0.75.3)

## Next.js and self-hosted Node compatibility

### Node runtime

- Pi agent, protocol, client, server, and SQLite packages declare Node
  `>=22.19.0`.
- Next.js 16.3.4 declares Node `>=20.9.0`.
- A combined deployment must therefore use Node 22.19 or newer.

Sources:

- The engine declarations are present in each published package's
  `package.json`, including
  [`pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core/v/0.85.1)
  and
  [`pi-server`](https://www.npmjs.com/package/@earendil-works/pi-server/v/0.85.1).
- [Next.js system requirements](https://nextjs.org/docs/app/getting-started/installation#system-requirements)

### Route Handlers

Current Next.js documentation states:

- Route Handlers use Web `Request` and `Response`.
- They support `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`.
- They can return a `ReadableStream` wrapped in a `Response`.
- The default route runtime is `nodejs`.
- The `edge` runtime is deprecated.
- `maxDuration` is available, but the effective execution limit is set by the
  deployment platform.

Sources:

- [Route Handler reference](https://nextjs.org/docs/app/api-reference/file-conventions/route)
- [Route Handler streaming](https://nextjs.org/docs/app/api-reference/file-conventions/route#streaming)
- [Route runtime](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/runtime)
- [`maxDuration`](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config/maxDuration)

This is mechanically compatible with:

- Running the agent inside a Node Route Handler.
- Returning a `ReadableStream` of application-formatted events.
- Connecting a Node Route Handler to a local Pi Unix-socket server.

It is not by itself evidence that a long-running agent should be tied to one
request. `maxDuration`, proxy buffering, request aborts, and process
replacement can all terminate or strand a request-scoped run.

### Self-hosting

Current Next.js self-hosting documentation states:

- `next start` is the supported Node.js server path.
- App Router streaming works with self-hosting, but reverse proxies must
  disable buffering.
- Multiple instances require shared cache coordination in addition to normal
  application coordination.
- Graceful shutdown should use `SIGINT` or `SIGTERM` and wait for in-flight
  requests and `after()` work.

Sources:

- [Self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting)
- [Streaming guide](https://nextjs.org/docs/app/guides/streaming)

Relevant consequence:

- A single self-hosted `next start` process with persistent local storage can
  host both the application and an in-process Pi worker.
- Multiple Next.js instances, serverless functions, or autoscaled containers
  create a session ownership problem because Pi has no distributed session
  writer lease.

### WebSocket question

The reviewed official Next.js documentation does not document a Route Handler
WebSocket upgrade API. Its custom-server guide says a custom server exists for
patterns the integrated router cannot meet and shows `next()` wrapping a
Node HTTP server. Pi's client API allows a WebSocket transport, but neither Pi
nor Next.js provides the complete browser-to-durable-session bridge in the
packages reviewed here.

Sources:

- [Next.js custom server guide](https://nextjs.org/docs/pages/guides/custom-server)
- [Pi client transport interface](https://github.com/earendil-works/pi/blob/v0.85.1/packages/client/src/transport.ts)

## Tradeoff matrix

| Choice | Benefit | Cost or unresolved issue |
| --- | --- | --- |
| Browser-local `Agent` | Simple deployment; no server session writer | No durable server harness; browser storage and process are the authority |
| `MemorySessionRepo` | Fast and testable | Lost on process exit |
| JSONL repository | Inspectable file history; no SQLite dependency | File layout and ownership are host concerns; close/ownership semantics have a TODO |
| SQLite repository | Transactions, WAL, schema, branch indexes, usage ledger | Local durability only by default; no cross-process writer safety |
| Single self-hosted Next.js process | Route streaming and long-lived Node are available together | Scaling and process replacement still require recovery and ownership policy |
| Multiple Next.js instances | Horizontal serving capacity | Same session must be routed to one writer, or the application must add distributed coordination |
| Serverless Route Handlers | Simple request hosting | Request lifetime is platform-limited; background continuation and durable resumption need external work ownership |
| Pi Unix server plus Node bridge | Keeps remote-session routing and protocol separation | Requires a bridge to browser-safe SSE/WebSocket/NDJSON and application service contracts |
| Direct WebSocket transport | Browser-friendly byte stream | Must be implemented as an application transport; protocol remains CBOR and experimental |
| One session per conversation and lane per employee | Strong conversation grouping and per-lane model/tool config | Harness-level prompts/resources are shared; cross-lane context is application-defined |
| One session per employee with cross-session orchestration | Clear employee runtime isolation | Application must coordinate fan-out, ordering, shared context, and result merging |

## Open uncertainties

- No end-to-end Next.js integration is published in the Pi packages reviewed.
  A compatibility test with Next 16.3.4, ESM, `node:sqlite`, server tracing,
  and the project's deployment platform is still required.
- The SQLite changelog for `0.84.0` mentions "fenced writer leases," while the
  current `0.85.1` README says the package implements no cross-process lease,
  lock, fence, heartbeat, or takeover. The current README and current source
  should be treated as authoritative, but this contradiction should be
  rechecked before relying on multi-process SQLite behavior.
- The exact clean way to vary system prompt, skills, or tool definitions by
  employee inside one harness/session needs a focused prototype. The public
  types make model, thinking level, and active tool names lane-local, but
  prompts, resources, tool implementations, and projections harness-local.
- Browser delivery is not defined by the protocol. SSE, WebSocket, NDJSON, and
  snapshot/subscription combinations all require an application-level schema
  and reconnect/resume policy.
- The package READMEs do not define a supported multi-instance deployment
  pattern for JSONL or SQLite. A host-level lease, partition map, or
  session-to-worker router would need separate design and failure testing.
- Deferred provider requests expose `DeferredHandle`, `run_suspend`,
  `run_resume`, and durable `deferred.effect_pending` state, but the reviewed
  packages do not provide a scheduler that polls or resumes them across
  processes. The host must own that scheduler.
- No Pi-native queue package was found in the current package set. Queue and
  worker semantics are application concerns.
