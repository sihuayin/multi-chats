# Hardening egress for operator-defined HTTP Tools

What the shipped runtime (Node 22 + Next.js 16) lets us do, dependency-free, to pin the address a server-side HTTP Tool connects to, to stop redirects leaving the allowlist, and to bound keep-alive reuse. Every claim marked **[exec]** was verified by running code on this machine; **[read]** is a conclusion from source. Probe scripts are described in "How this was verified".

## Runtime facts

| fact | value | source |
| --- | --- | --- |
| Node | `.nvmrc` = `22`; `package.json` `engines.node` = `>=22.19.0`; probe host = v22.23.2 | `.nvmrc`, `package.json` **[read]** |
| bundled undici | `process.versions.undici` = `6.28.0` | **[exec]** |
| Next.js | 16.3.4 | `package.json` **[read]** |
| any route to undici from core | none. `require("node:undici")` → `ERR_UNKNOWN_BUILTIN_MODULE`; `process.getBuiltinModule("undici")` → `undefined`; no `undici` in `module.builtinModules`; no `node --help` flag | **[exec]** |
| `undici-types` | 7.18.2 present, but it is a **types-only** dep of `@types/node` describing undici **7.x** — it does not match Node 22's 6.28.0 | `node_modules/@types/node/package.json` **[read]** |
| `undici` npm package | **not a dependency, not resolvable** — `require.resolve("undici")` fails in the app tree, and it is not in Next's default `serverExternalPackages` | **[exec]**, `next/dist/lib/server-external-packages.jsonc` **[read]** |
| `globalThis.fetch` in a Route Handler | Next's **patched** fetch (source begins `async function(input,init){var _init_method,_init_next;let url;…`), wrapping undici 6.28.0 | **[exec]** |

The guard today is `assertSafeHttpUrl` (`src/server/security/ssrf.ts:3`) — hostname string only, no DNS. It has **three** call sites, not two: `src/server/application/tool-gateway.ts:189` (`fetch_url`), `:202` (`post_webhook`), and `src/server/application/text-extractor.ts:63`. The matching `fetch` calls are `tool-gateway.ts:190`, `:203`, `text-extractor.ts:64`; none passes a `redirect` option, so all three follow redirects.

## 1. Address pinning

**Nothing in the `fetch` surface can pin an address.** `fetch(url, { lookup })` is silently ignored — the lookup is never called and the request succeeds **[exec]**. WHATWG fetch has no such option; the only lever is the non-standard `dispatcher` init key.

`dispatcher` **is** honoured, including through Next's patch: passing a bogus dispatcher to `fetch` inside a Route Handler produces `fetch failed` (undici tried to use it) **[exec]**. But a usable `Dispatcher` (`undici.Agent`) cannot be constructed without the `undici` package, and `undici` is not resolvable here **[exec]**. (A duck-typed object with a `dispatch()` method *is* accepted — `dispatch()` is called — but hand-implementing undici's handler contract is unsupported and version-coupled; not recommended.) **[exec]**

One further dependency-free route exists and should be **rejected**: monkey-patching `require("node:net").connect` to inject a `lookup` does pin the IP of a plain `fetch()` call (verified at the `net.connect` layer) `[exec]`, because undici's connector bottoms out in `net.connect` / `tls.connect` `[read]`. But it is process-global mutable state affecting every connection in the server, it is unsupported, and it races with any concurrent non-Tool request. Do not put it in the spec.

**The dependency-free mechanism is `node:http` / `node:https` with a custom `lookup`.** Node's `net.connect` consults `lookup` for **names**, and the option can be supplied per-request or on an `Agent` **[exec]**. Wrapping `dns.lookup(hostname, { all: true })` lets the guard see *every* resolved address and drop the disallowed ones before any connect happens:

| case (stubbed resolver) | result **[exec]** |
| --- | --- |
| one public address, allowlist denies host | kept |
| one private address, allowlist denies host | denied (`EGRESS_DENIED`) |
| **public + private together**, allowlist denies host | private dropped, public kept — the private one is unreachable |
| public + private, host allowlisted | both kept |
| private IPv6 (`::1`, `fd00::`), allowlist denies host | denied |
| `all: false` callers | callback shape `(err, address, family)` still correct |

`dns.lookup` requests `{ all: true, hints: 1024 }` from Node's own connect path **[exec]**, so the multi-address form is the normal case, not an edge case. Address classification that matters and is easy to miss: `::ffff:127.0.0.1` (IPv4-mapped) and `172.32.0.0` (outside `172.16/12`) — both handled correctly by the probe's classifier **[exec]**.

Two things pinning does **not** cover, and the guard must keep covering them separately:

- **Literal IP hostnames bypass `lookup` entirely.** `http://127.0.0.1:PORT/` with an allowlist that permits only `localhost` returned **200** **[exec]**. `net.connect` skips resolution for IP literals. So the syntactic check on the URL (what `assertSafeHttpUrl` already does) stays load-bearing; the `lookup` covers only the DNS case. The two are complementary, not redundant.
- **TLS identity is preserved.** With `lookup` pinning `localhost` to `127.0.0.1`, the TLS socket still reports `servername = "localhost"` and `remoteAddress = "127.0.0.1"` **[exec]** — SNI and certificate identity verify against the hostname, not the pinned IP. No manual `servername` is needed.

**Timeouts.** Node's HTTP client has **no connect timeout**. `req.setTimeout(n)` does *not* fire during connect — a request to a blackhole address with `timeout: 1200` was still pending after 120 s **[exec]**. Connect time must be bounded by an explicit timer armed on the `'socket'` event and cleared on `'connect'` (probe fired at 802 ms for an 800 ms timer **[exec]**). Total time is bounded by an `AbortController` `signal`, which is separate and composable (`AbortSignal.any([runSignal, toolTimeout])`) **[exec]**. Undici's `connect.timeout` / `headersTimeout` / `bodyTimeout` give the same separation if the dependency route is taken **[exec]**: `connect: { timeout: 1000 }` aborted at 1494 ms.

## 2. Redirect handling

Node's `http.request` **never follows redirects** — the property falls out of the transport, so the dependency-free mechanism gets requirement (b) for free **[read]**.

If `fetch` is kept, `redirect: "manual"` and `redirect: "error"` both work, **and both survive Next's fetch patch inside a Route Handler** **[exec]**:

| mode | observed **[exec]** |
| --- | --- |
| `follow` (default, today) | 302 followed, body = final page |
| `manual` | status 302, `type: "default"` (not browser `opaqueredirect`), `Location` readable, body readable |
| `error` | throws `TypeError: fetch failed` |

So `redirect: "error"` is a one-line, dependency-free way to close the redirect hole for the existing built-ins — but it converts a followed redirect into a hard failure, and it does nothing about DNS.

For faithful behaviour, follow manually and re-validate each hop. What "re-validate" has to mean, per hop: the syntactic guard **and** the allowlist. A redirect hop to a literal `169.254.169.254` is not caught by `lookup` at all — in the probe it got as far as a TCP connect and failed only with `EHOSTUNREACH` **[exec]**. Per-hop re-validation must therefore be the same function as first-hop validation.

The algorithm to reproduce, read off the undici 6.28.1 source this app actually runs (`node_modules/undici/lib/web/fetch/index.js`, `constants.js`) **[read]**:

- redirect statuses: `[301, 302, 303, 307, 308]` (`constants.js:8`);
- cap: `request.redirectCount === 20` → network error `redirect count exceeded` (`index.js:1248`);
- `Location` whose scheme is not HTTP(S) → network error (`index.js:1244`);
- method rewrite to `GET` when `[301,302]` and method is `POST`, or `303` and method is not `GET`/`HEAD` (`index.js:1290-1296`);
- cross-origin hop deletes `authorization`, `proxy-authorization`, `cookie`, `host` (`index.js:1306-1320`).

## 3. Connection reuse

Measured against a single origin (`flip.example:PORT`) with a resolver that changes its answer between requests **[exec]**:

| step | result |
| --- | --- |
| request 1, resolver → `127.0.0.1` | served by A, 1 lookup |
| resolver flips to `::1`, request 2 (same origin) | **still served by A**, lookups still 1 — pooled socket reused, no re-resolution |
| `agent.destroy()`, request 3 | resolver consulted, served by B |

So keep-alive reuse **cannot move an in-flight request to a newly-resolved address**: the socket stays on the address that was validated when it was created. The residual exposure is a *stale* socket to an address whose ownership has since changed — bounded by how long an idle socket is kept.

Node's `http.Agent` does **not** bound that by default: with `{ keepAlive: true }` and a 1500 ms idle gap the socket was reused **[exec]**. Setting `timeout` on the agent bounds it — `{ keepAlive: true, timeout: 600 }` forced a new socket (and a fresh `lookup`) after 1500 ms idle **[exec]**. `keepAliveMsecs` is *not* this knob; it only sets the TCP keep-alive probe delay. `maxSockets` and `agent.destroy()` are the other levers.

## The mechanism, concretely

No new dependency. One egress module replacing `fetch` on the HTTP-Tool path:

1. `assertSafeHttpUrl`-equivalent on the URL, made **allowlist-aware**: literal private IPs, `localhost`, and `.local` are denied *unless* the exact host (+ optional port) is allowlisted, at which point they are permitted. This is what lets the in-process fixture server on localhost, and `.local` names, be reached on an explicit allowlist while the default stays deny.
2. `http.Agent` / `https.Agent` carrying `lookup: pinnedLookup` — `dns.lookup(…, { all: true })`, classify every address, drop disallowed ones, error `EGRESS_DENIED` if none survive. Hosts on the allowlist keep their private addresses (verified: allowlisted `localhost` over TLS resolved and connected to both `::1` and `127.0.0.1`; the same request with a deny-all allowlist failed with `EGRESS_DENIED`) **[exec]**.
3. Manual redirect loop, cap 20, re-running step 1 on every hop, with the undici method-rewrite and cross-origin header-stripping rules above.
4. Connect timeout by timer on `'socket'`/`'connect'`; total timeout via `AbortSignal.any([runSignal, toolTimeout])`.
5. Agent with an idle `timeout` (and `destroy()` on shutdown) to bound stale-socket reuse.

Every step above was executed in isolation against a fixture server; the pieces compose because 2–5 all live on the same `http.request` call.

## If `fetch` must be kept

The smallest dependency that buys connect-time pinning while keeping `fetch` is **`undici`** — measured at **1.5 MB unpacked, 99 JS files, zero transitive dependencies** (`engines.node >= 18.17`) **[exec]**. `new Agent({ connect: { lookup } })` pins at connect and denies correctly, and `connect: { timeout }` bounds connect separately **[exec]**. A package `Agent` from `undici@6.28.1` handed to Node's **built-in** `globalThis.fetch` worked — including decompression, and denying a blocked hostname **[exec]** — which is cross-instance, duck-typed dispatch that happens to line up because the versions match (package 6.28.1 vs Node's internal 6.28.0). `setGlobalDispatcher` from the package does **not** affect the built-in fetch **[exec]**, so the dispatcher must be passed per request.

Three caveats if this route is taken, all from Next 16.3.4's own source `[read]`:

- **`dispatcher` survives only on the `fetch(url, init)` shape.** Next rebuilds `init` from an explicit whitelist when the input is a `Request` (`cache, credentials, headers, integrity, keepalive, method, mode, redirect, referrer, referrerPolicy, window, duplex` — `dispatcher` is absent, and the string does not appear anywhere in `patch-fetch.ts`). The app's call sites pass a `URL` object, not a `Request`, and take the spread path where `init` is preserved — but `fetch(new Request(url, { dispatcher }))` would silently lose it.
- **The dedupe layer can collapse two calls with different dispatchers.** `createDedupeFetch` keys on `[method, filteredHeaders, mode, redirect, credentials, referrer, referrerPolicy, integrity]`; `dispatcher` is not in the key, and the source carries an explicit "we currently don't consider non-standard (or future) options. This might not be safe" note. `options.signal` is absent only on GET/HEAD without a signal — which is exactly the `fetch_url` shape.
- **The dispatcher must be passed per request.** Next installs no global dispatcher for the Node runtime (no `setGlobalDispatcher` under `next/dist/server/**`), so Node's global undici Agent stays in place for every other request.

`dispatcher` reaches undici through Next's patch **[exec]**, and `undici` is *not* in Next's default externals, so it would be bundled into the server build. It is server-only code and never enters the client bundle, but it cannot be scoped to the Tool egress path alone — the package lands in the dependency tree and in the server bundle.

**Recommendation:** take the dependency-free route for the Tool egress path. If the team would rather keep `fetch`, `undici` is the only way to do it, and the honest cost is 1.5 MB plus a version-coupling to whatever undici Node ships.

## Can `fetch_url` / `post_webhook` adopt it unchanged?

The mechanism is adoptable; the fidelity work is real but bounded.

Preserved: `details.status` and `details.url` (the *original* URL — the code passes the `url` variable, not `response.url`, so keeping the original across redirects is faithful), `content` truncated at 50 000 chars, non-2xx is not specially handled, cancellation via `signal`, and errors landing in `errorKind: "execution"`. `text-extractor.ts:64` reads `response.ok` and `response.text()`, so the module should return a real `Response`; `new Response(buffer, { status, statusText, headers })` reproduces `status`, `ok`, `headers.get()`, and `text()` faithfully **[exec]** (`.url` comes back `""` and `.type` `"default"` — no call site reads either **[read]**).

Must be re-implemented to avoid a server-visible difference: undici sends `accept: */*`, `accept-language: *`, `sec-fetch-mode: cors`, `accept-encoding: gzip, deflate`, `connection: keep-alive` and transparently decompresses (`content-encoding: gzip` remains on the headers while `text()` returns plaintext) **[exec]**. Bare `node:http` sends no `accept-encoding` and returns raw gzip bytes **[exec]**. `node:zlib` covers gzip/deflate/brotli dependency-free.

The one behaviour that genuinely changes: a redirect that leaves the allowlist, or that targets a private address, **now fails instead of succeeding**. Today `fetch_url` follows such a redirect and returns the private page's content. That is precisely the hole the map asks to close, not a regression — but it is observable, and the spec should say so. For every destination that is reachable today *legitimately*, results are unchanged.

## Verdict

| requirement | dependency-free? | how |
| --- | --- | --- |
| pin the resolved address at connect, multi-address, deny-by-default with allowlist override | **yes**, but not with `fetch` | `node:http(s)` + custom `lookup` |
| no redirect can leave the allowlist | **yes**, even with `fetch` | `redirect: "error"`, or manual loop with per-hop re-validation |
| bound keep-alive reuse | **yes** | per-origin pooling + agent `timeout` + `destroy()` |
| keep `fetch` **and** pin the address | **no** | requires `undici` (1.5 MB, zero transitive deps); only on the `fetch(url, init)` shape, and only on the non-deduped path |

The single finding that bounds the spec: **address pinning and `fetch` are mutually exclusive without a new dependency.** Redirect control is not — it is available today with `redirect: "error"`.

## How this was verified

Executed on Node v22.23.2 / Next.js 16.3.4, all against in-process `node:http` fixture servers on loopback (no external service, no credentials):

- `[exec]` markers: ~14 standalone probe scripts plus a live `next dev` Route Handler, covering fetch `redirect` modes, `dispatcher` passthrough through Next's patch, `fetch`/`lookup` interaction, undici `Agent` + `connect.lookup` / `connect.timeout`, the pinned-lookup classification table, TLS `servername` under pinning, connect-timeout hooks, and keep-alive reuse across re-resolution.
- `[read]`: Next's `patch-fetch.js` (patch installation, the `Request`-input whitelist, `dedupe-fetch.js`) and `server-external-packages.jsonc`; undici 6.28.1's `lib/web/fetch/index.js` / `constants.js` for the redirect algorithm; undici 6.28.0's `lib/core/connect.js` / `lib/dispatcher/*` for the connector pass-through and the origin-keyed, never-evicted client map.
- The temporary Route Handler used for the Next probes was removed and the working tree restored; nothing but this document is in the commit.
