# Pi SDK package and integration boundaries

Research date: 2026-09-11

## Scope

This note identifies the current public Pi SDK packages relevant to a Next.js and
TypeScript agent application. It covers package identities, public entry points,
runtime boundaries, composition patterns, and known integration constraints.

The release packages inspected here all identify
`d981de1229ef899957bbe968bc8dcda02a21f477` as their source commit. The upstream
repository is [earendil-works/pi](https://github.com/earendil-works/pi), and the
pinned source tree used for the source links below is
[commit `d981de1`](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477).

## Short answer

There is no current published `@earendil-works/pi-core`,
`@earendil-works/pi-agent`, or `@earendil-works/pi-chat` package.

- `pi-core` most likely refers to `@earendil-works/pi-agent-core`.
- `pi-agent` most likely refers to either `@earendil-works/pi-agent-core` or the
  higher-level `@earendil-works/pi-coding-agent`, depending on whether the agent
  loop or the complete coding-agent session is intended. There is also a
  deprecated historical `@mariozechner/pi-agent@0.9.0`, but it is not part of the
  current release line.
- `pi-chat` is a separate Apache-2.0 Pi extension repository at
  [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat). It bridges
  Discord and Telegram to a sandboxed Pi session. It is not a web/chat SDK and is
  not published under the Earendil npm scope. Its repository package is
  `pi-chat@0.1.0`, while the unrelated `pi-chat@1.0.0` on npm is a different
  terminal chat package.

The current Pi SDK release train is `0.85.1`:

| Package | Latest | Intended boundary |
| --- | ---: | --- |
| `@earendil-works/pi-ai` | `0.85.1` | Unified model API and provider adapters |
| `@earendil-works/pi-agent-core` | `0.85.1` | Agent loop, tools, events, harness, sessions |
| `@earendil-works/pi-coding-agent` | `0.85.1` | Full coding-agent session, resources, CLI, RPC |
| `@earendil-works/chord` | `0.85.1` | Service composition, RPC, replicated state |
| `@earendil-works/pi-protocol` | `0.85.1` | Experimental framed CBOR remote-session protocol |
| `@earendil-works/pi-client` | `0.85.1` | Experimental transport-neutral protocol client |
| `@earendil-works/pi-server` | `0.85.1` | Experimental local server and session routing |
| `@earendil-works/pi-session-backend-sqlite-node` | `0.85.1` | Node `node:sqlite` session persistence |
| `@earendil-works/pi-web-ui` | `0.75.3` | Older reusable web components, outside `0.85.x` |

Package pages:

- [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)
- [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
- [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- [chord](https://www.npmjs.com/package/@earendil-works/chord)
- [pi-protocol](https://www.npmjs.com/package/@earendil-works/pi-protocol)
- [pi-client](https://www.npmjs.com/package/@earendil-works/pi-client)
- [pi-server](https://www.npmjs.com/package/@earendil-works/pi-server)
- [pi-session-backend-sqlite-node](https://www.npmjs.com/package/@earendil-works/pi-session-backend-sqlite-node)
- [pi-web-ui](https://www.npmjs.com/package/@earendil-works/pi-web-ui)

The previous `@mariozechner/pi-*` package family still exists at `0.73.1`, but it
is not the current Earendil release line. The `pi-chat` repository still declares
the old scoped packages as peers, which is a version-boundary mismatch:

```json
{
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  }
}
```

Source:
[pi-chat package.json](https://github.com/earendil-works/pi-chat/blob/9adbd29b40ee27ff1decf0fc87cbe180b40924f5/package.json)

The old `@mariozechner/pi-agent@0.9.0` package is marked deprecated and points at
the old `badlogic/pi-mono` repository. The later `@mariozechner/pi-agent-core`
package carried the current agent implementation until it was deprecated in
favor of [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core).

## Runtime and entry-point matrix

All current `@earendil-works/pi-*` `0.85.1` packages inspected declare:

```json
"engines": {
  "node": ">=22.19.0"
}
```

The current machine has Node `v20.19.4`, so it does not satisfy the declared Pi
runtime requirement.

### `@earendil-works/pi-ai`

Public exports:

| Export | Purpose |
| --- | --- |
| `@earendil-works/pi-ai` | Side-effect-free core API, models, auth types, utilities |
| `@earendil-works/pi-ai/providers/*` | Individual provider factories and catalogs |
| `@earendil-works/pi-ai/api/*` | Direct provider API implementations |
| `@earendil-works/pi-ai/compat` | Legacy global API; discouraged for bundled apps |
| `@earendil-works/pi-ai/oauth` | OAuth support |
| `@earendil-works/pi-ai/bedrock-provider` | Bedrock provider module |
| `@earendil-works/pi-ai/bun-oauth` | Bun-specific OAuth support |

The package manifest says:
[packages/ai/package.json](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/package.json)

The root entry point intentionally contains no generated catalog, provider
factory, API registry, OAuth implementation, or compatibility layer:
[packages/ai/src/index.ts](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/index.ts)

The official README explicitly says:

- The core entry point and provider factories work in browsers and bundle cleanly.
- Browser callers must pass API keys explicitly or inject a credential store.
- Exposing provider keys in frontend code is unsafe; production use should go
  through a backend proxy.
- Bedrock is not supported in browsers.
- OAuth login is Node-only.
- Import individual providers to keep provider SDKs tree-shaken and lazy.

Sources:

- [Browser usage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/README.md#L1409-L1431)
- [Bundling and tree shaking](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/README.md#L1434-L1470)

Minimal official pattern:

```ts
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const result = await models.complete(model, {
  messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});
```

The published package dist contains Node builtins in Bedrock, OAuth, CLI, and
environment-key code, but the root import is side-effect-free. Those Node-only
paths should not be pulled into client components.

### `@earendil-works/pi-agent-core`

Public exports:

| Export | Purpose |
| --- | --- |
| `@earendil-works/pi-agent-core` | `Agent`, loop, harness, tools, sessions, types |
| `@earendil-works/pi-agent-core/node` | `NodeExecutionEnv` plus the root API |
| `@earendil-works/pi-agent-core/harness/context` | Harness context |
| `@earendil-works/pi-agent-core/harness/session` | Session implementations and contracts |
| `@earendil-works/pi-agent-core/harness/env/nodejs` | Node filesystem and shell execution |
| `@earendil-works/pi-agent-core/harness/runtime/reducer` | Runtime snapshot reduction |
| `@earendil-works/pi-agent-core/harness/session/testing` | Conformance and test utilities |

Sources:

- [package manifest](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/package.json)
- [root exports](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/index.ts)
- [Node exports](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/node.ts)

The main composition object is `Agent`. It owns transcript state, model calls,
tool execution, steering/follow-up queues, and lifecycle events.

```ts
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    // Forward event.assistantMessageEvent.delta to the application's stream.
  }
});

await agent.prompt("Hello!");
```

Source:
[Agent quick start](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/README.md#L15-L42)

Important boundaries:

- The root package contains no `node:` imports in the published `0.85.1` dist
  except its `node` subpath and session conformance-test helpers.
- `NodeExecutionEnv` is explicitly Node-only.
- The README documents browser use through `streamProxy`, where the browser Agent
  calls an application backend rather than holding provider credentials.
- The session backend is pluggable. The default `MemorySessionRepo` is
  process-local. The SQLite implementation ships separately so the core package
  does not pull in runtime builtins or native dependencies.

Browser proxy pattern:

```ts
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

Sources:

- [Proxy usage](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/README.md#L460-L475)
- [SQLite backend boundary](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/README.md#L1-L14)
- [AgentHarness contract](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/agent-harness.ts)

### `@earendil-works/pi-coding-agent`

This is the batteries-included layer. It wraps the core Agent in an
`AgentSession`, adds resource loading, coding tools, settings, compaction,
session files, CLI modes, extensions, and a JSONL RPC mode.

Relevant exports:

| Export | Purpose |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `createAgentSession`, `AgentSessionRuntime`, `SessionManager`, etc. |
| `@earendil-works/pi-coding-agent/rpc-entry` | Bundled RPC entry |
| `@earendil-works/pi-coding-agent/client` | Source-only client export |
| `@earendil-works/pi-coding-agent/experimental/plugin` | Source-only experimental plugin export |

Source:
[package manifest](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/package.json)

Direct Node embedding:

```ts
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    // Stream the delta to the caller.
  }
});

await session.prompt("Summarize the current workspace.");
```

Sources:

- [SDK quick start](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L11-L31)
- [AgentSession interface](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L55-L112)
- [Session runtime](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md#L114-L190)

The official RPC documentation recommends direct `AgentSession` embedding for
Node.js applications and reserves subprocess RPC for non-Node or isolated
process integration:

- [RPC mode guidance](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/rpc.md#L1-L12)
- [RPC framing](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/rpc.md#L25-L42)

This package is Node-oriented and adds substantial CLI, filesystem, shell, and
process dependencies. It is a poor fit for the browser bundle, even if some
types are importable.

### `@earendil-works/chord`

Chord is the application-composition and service layer underneath the modern
Harness and server/client protocol. The `0.85.1` package describes itself as an
application composition runtime for services, replicated state, RPC, and
plugins. It has a root export plus `context`, `delta`, `bundler`, and `node`
subpaths.

Source:
[package metadata](https://www.npmjs.com/package/@earendil-works/chord/v/0.85.1)

The agent core intentionally does not re-export the service runtime. Applications
that need it compose Chord services themselves.

### `@earendil-works/pi-protocol`

This package is runtime-neutral framing and schema:

- Protocol version `8`.
- Routed envelopes for server and Session targets.
- Framed CBOR over an ordered byte transport.
- Four-byte big-endian frame length followed by a definite-length CBOR item.
- Strict JSON validation for opaque service payloads.
- Default limits of 16 MiB, 1,000,000 collection entries, and 64 nesting levels.
- No compatibility guarantees.
- Peer authentication is not implemented.

Sources:

- [package README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/protocol/README.md)
- [package exports](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/protocol/src/index.ts)

Minimal framing example from the upstream README:

```ts
import {
  PROTOCOL_VERSION,
  encodeClientMessage,
  ServerMessageDecoder,
  type ClientHello,
} from "@earendil-works/pi-protocol";

const hello: ClientHello = { type: "hello", version: PROTOCOL_VERSION };
transport.send(encodeClientMessage(hello));

const decoder = new ServerMessageDecoder({ maxFrameLength: 1024 * 1024 });
for (const message of decoder.push(incomingChunk)) handleServerMessage(message);
decoder.end();
```

### `@earendil-works/pi-client`

This is not an HTTP client. It is a transport-neutral client over framed CBOR
bytes. The application supplies a `ByteTransportFactory`; the README names
WebSocket, Unix sockets, and other ordered byte transports as possibilities.

The built-in transport subpath is Unix-only:

```ts
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";

const client = new Client({
  serverId,
  transportFactory: createUnixTransportFactory({ path: "/tmp/pi.sock" }),
});

await client.connect();
```

Sources:

- [package README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/client/README.md)
- [package exports](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/client/src/index.ts)

The root package does not import Node builtins in its published dist, but the
`unix` subpath does. A browser or Next.js integration would need to provide a
custom transport, such as a WebSocket byte stream, and application-level
authentication.

The client does not reconnect or replay requests automatically. Accepted work
may complete remotely after the client disconnects.

### `@earendil-works/pi-server`

The package describes itself as an experimental local server for durable Session
and Agent Harness interfaces.

Key properties:

- Server services and Session services are routed through opaque service
  envelopes.
- A Session can have multiple presentation attachments.
- `attachmentId` fences routing after attach/detach.
- The server does not own application business schemas.
- The application supplies `SessionDirectory`, `SessionManagement`, a Session
  resolver, and a routed Session factory.
- The real Session and Harness do not cross the process boundary.
- Server and worker lifecycle is outside the public protocol.
- The built-in transport is Unix domain socket.
- The Unix transport does not implement peer authentication.

Sources:

- [package README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/server/README.md)
- [root exports](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/server/src/index.ts)

The root package itself is mostly contracts and routing code, but Unix transport,
the SQLite backend, and the coding-agent layer are Node-specific. The protocol
notes explicitly call the package experimental and without compatibility
guarantees.

### `@earendil-works/pi-session-backend-sqlite-node`

This is the current durable Node session backend. It:

- Uses `node:sqlite`.
- Creates one database per Session by default.
- Supports shared containers through `databasePath`.
- Requires one writable owner per Session.
- Implements no cross-process lease, lock, fence, heartbeat, or takeover.
- Does not export search or FTS.

Sources:

- [package README](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/session-backends/sqlite-node/README.md)
- [package manifest](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/session-backends/sqlite-node/package.json)

Example:

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import {
  createNodeSqliteFactory,
  SqliteSessionRepo,
} from "@earendil-works/pi-session-backend-sqlite-node";

const repository = new SqliteSessionRepo({
  directory: "/var/lib/pi/sessions",
  databaseFactory: createNodeSqliteFactory(),
});

const session = await repository.create({}, BACKGROUND_CONTEXT);
const main = await session.createBranch("main", null, BACKGROUND_CONTEXT);

await main.appendMessage(
  { role: "user", content: "hello", timestamp: Date.now() },
  BACKGROUND_CONTEXT,
);
```

### `@earendil-works/pi-web-ui`

This package is a separate, older web-components package. Its latest published
version is `0.75.3` from 2026-05-18, and it depends on
`@earendil-works/pi-ai@^0.75.3`. It is outside the current `0.85.1` release train.
Do not assume it is compatible with `0.85.1` without a separate compatibility
test.

Source:
[pi-web-ui package metadata](https://www.npmjs.com/package/@earendil-works/pi-web-ui/v/0.75.3)

## How the packages compose

There are four distinct composition levels. They should not be treated as
interchangeable SDK layers.

### 1. Model API only

Use `pi-ai` when the application owns the agent loop, tool orchestration, and
message persistence:

```text
application -> pi-ai provider -> model response
```

This is the smallest browser/server boundary. Provider credentials still belong
on the server in production.

### 2. Agent runtime

Use `pi-agent-core` when the application wants Pi's agent loop and event model
but wants to own products, persistence, and UI:

```text
application state
  -> Agent
     -> pi-ai stream function
     -> AgentTool[]
     -> lifecycle events
```

The `Agent` is process-local and stateful. Persisting its message history is the
application's responsibility unless the application uses the newer Harness and
session repositories.

### 3. Complete coding-agent session

Use `pi-coding-agent` when the application wants the full library that powers
the CLI:

```text
AgentSession
  -> Agent
  -> ResourceLoader
  -> tools and extensions
  -> compaction
  -> SessionManager / AgentSessionRuntime
```

This is the shortest path to a general-purpose agent in a Node process, but it
brings coding-agent assumptions and dependencies.

### 4. Remote session protocol

Use the `chord` + protocol + client/server layers only when a separate worker
process must own Session state:

```text
web/API gateway
  -> pi-client
  -> ordered byte transport
  -> pi-protocol
  -> pi-server
  -> application Session router
  -> Agent Harness
```

Clients must provide authentication, transport, reconnection policy, routing
identity, and lifecycle. The current implementation is explicitly experimental.

## Next.js compatibility implications

### Use the Node.js runtime

Pi `0.85.1` requires Node `>=22.19.0`. Next.js 16's default route runtime is
already `nodejs`, and the Edge Runtime is deprecated. Do not deploy Pi SDK work
to Edge or browser runtimes.

Sources:

- [Next.js runtime route segment config](https://github.com/vercel/next.js/blob/ccef3db535aa163a883f6ac000bdceb16b13e5e5/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/runtime.mdx)
- [Next.js Node module error in Edge Runtime](https://github.com/vercel/next.js/blob/ccef3db535aa163a883f6ac000bdceb16b13e5e5/errors/node-module-in-edge-runtime.mdx)

An explicit server route can look like:

```ts
// app/api/agent/route.ts
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json();

  const response = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // Create or restore the application-owned agent session here.
      // Pipe Agent events into this response stream as SSE or NDJSON.
      controller.enqueue(encoder.encode(`${JSON.stringify(body)}\n`));
      controller.close();
    },
  });

  return new Response(response, {
    headers: { "content-type": "application/x-ndjson" },
  });
}
```

The agent instance should not be treated as ordinary request-scoped data when
sessions are durable. A route handler may resume a stored session, but the
application must define who owns that live Session while it is running.

### Keep SDK imports server-only

Use `server-only` or an equivalent module boundary around Pi server code. Do not
import `pi-coding-agent`, the SQLite backend, `NodeExecutionEnv`, OAuth, Bedrock,
or the Unix server/client subpaths from client components.

If Next.js has trouble bundling a provider SDK or native dependency, use:

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-session-backend-sqlite-node",
  ],
};

export default nextConfig;
```

Source:
[Next.js `serverExternalPackages`](https://github.com/vercel/next.js/blob/ccef3db535aa163a883f6ac000bdceb16b13e5e5/docs/01-app/03-api-reference/05-config/01-next-config-js/serverExternalPackages.mdx)

This configuration is not automatically required. It is the documented escape
hatch for dependencies using Node-specific behavior that should be loaded by
Node rather than bundled by Next.js.

### Serverless is a poor default for live session ownership

The Pi agent and Harness are process-local. The SQLite backend requires one
writable owner and does not implement cross-process fencing or takeover. Next.js
serverless deployments can run multiple instances and freeze requests between
invocations.

Consequences:

- An in-memory Agent or MemorySessionRepo cannot survive an arbitrary request or
  instance switch.
- A SQLite file needs a single stable writer, not concurrent serverless replicas.
- Long-running agent work needs a durable job/worker model or a stable Node
  process.
- The experimental client/server protocol is one possible isolation boundary,
  but it is not a ready-made authentication or deployment layer.

### A browser-only direct SDK integration is possible but not the production
### boundary

`pi-ai` officially supports browser providers, but doing so exposes provider
credentials. `pi-agent-core` documents the safer browser-proxy pattern. For a
product, the browser should own presentation and streaming state, while a Node
backend owns provider credentials and agent execution.

### `pi-chat` is an integration reference, not a web SDK

The `pi-chat` extension imports:

- `node:child_process`
- `node:crypto`
- `node:fs`
- `node:path`
- Discord.js and WebSocket dependencies
- `@earendil-works/gondolin`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`

It expects QEMU, a Gondolin guest image, and tmux. Its README describes a
per-channel micro-VM, persistent workspace, shared storage, Discord/Telegram
bridges, and encrypted secret exchange.

Source:
[pi-chat repository root](https://github.com/earendil-works/pi-chat)

Use it to study multi-channel routing, inbox queueing, per-conversation durable
state, and sandbox boundaries. Do not import it into a Next.js web bundle or
assume its account/channel model maps directly to employees and discussion
groups.

## Concrete boundary failure modes

| Failure | Cause | Mitigation |
| --- | --- | --- |
| Package engine warning or unsupported syntax | Local Node 20 versus Pi's Node `>=22.19.0` | Require Node 22.19+ for development and deployment |
| Browser bundle pulls `node:fs` or `node:child_process` | Importing agent node subpaths, OAuth, Bedrock, SQLite, or coding-agent code into client components | Keep those imports in server-only modules |
| API keys appear in browser traffic | Calling model providers directly from the client | Proxy model/agent calls through a Node server |
| Session disappears between requests | `MemorySessionRepo` or process-local Agent behind serverless routing | Use a stable owner process or durable external coordination |
| Two SQLite writers corrupt ownership assumptions | Multiple Next instances open the same Session | Enforce one writer per Session; do not deploy shared SQLite to replicas |
| Protocol client cannot reconnect | Experimental client intentionally never reconnects or replays automatically | Implement reconnect and safe retry in the application |
| WebSocket protocol works locally but not in production | No built-in web transport; only Unix transport ships | Implement and authenticate an ordered WebSocket byte transport |
| `pi-chat` cannot be installed with current SDK | Its peers still point at `@mariozechner/*` `0.73.x`; current packages are `@earendil-works/*` `0.85.1` | Treat it as a fork/reference until its peer dependencies are migrated |
| UI components drift from SDK types | `pi-web-ui` remains at `0.75.3` while core is `0.85.1` | Pin and compatibility-test separately, or build product UI directly |

## Recommended working assumptions

These are research implications, not a product architecture decision:

1. Treat `pi-ai` and `pi-agent-core` as the likely foundation for this product.
2. Treat `pi-coding-agent` as the batteries-included Node execution layer and
   decide later whether its coding-agent assumptions fit.
3. Keep all provider credentials, tool execution, and durable session ownership
   on a Node backend.
4. Keep `pi-chat` outside the web application boundary; use it as an integration
   reference for channel queues, long-lived state, and sandboxing.
5. Do not depend on the `client`/`server`/`protocol` packages until authentication,
   lifecycle, and deployment ownership are explicitly designed.
6. Lock all core Pi packages to one compatible release line rather than mixing
   `0.75.x`, `0.73.x`, and `0.85.x`.

## Open uncertainties

- The `pi-chat` repository is on a separate release cadence and still references
  the old `@mariozechner` package family. Its compatibility with Earendil
  `0.85.1` is not established.
- `pi-agent-core` documents a browser proxy path, but the package does not
  declare browser-specific export conditions or a browser support matrix. Browser
  compatibility should be treated as an integration-specific claim until tested
  with the chosen bundler.
- Production Next.js bundling was not executable on this machine because the
  installed Node 20 runtime does not satisfy the Pi package engine requirement.
- The experimental client/server protocol has no compatibility guarantee and no
  built-in peer authentication. Whether it is suitable as an internal worker
  boundary requires a separate decision.
- The current SQLite Session backend has no cross-process ownership protocol.
  The application must select and enforce its own single-writer topology.
- `pi-web-ui@0.75.3` may be useful as a component reference, but its compatibility
  with current `0.85.1` SDK types and package exports is unverified.
