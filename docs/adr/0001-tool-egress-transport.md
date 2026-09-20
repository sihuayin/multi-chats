# Tool egress uses its own `node:http` transport, not `fetch`

Server-side Tool calls must connect only to an address the Workspace allowlist permits. In this runtime address pinning and `fetch` are mutually exclusive: `fetch(url, { lookup })` is silently ignored, and a usable `Dispatcher` cannot be constructed without the `undici` package, which is not a dependency. The Tool egress path therefore gets its own module built on `node:http` / `node:https` with a custom `lookup`, and `fetch` is removed from every server-side Tool call site — both built-in HTTP Tools and Source URL ingestion — so that one Workspace has one egress semantics.

## Considered Options

Adding `undici` (1.5 MB unpacked, 99 files, zero transitive dependencies) and keeping `fetch` with `new Agent({ connect: { lookup } })` was measured to work, and was rejected on failure shape rather than weight. Next 16 passes `dispatcher` through only on the `fetch(url, init)` shape; the string appears nowhere in `next/dist/server/lib/patch-fetch.js` or `next/dist/server/lib/dedupe-fetch.js`, whose key is built from method, headers, `referrerPolicy`, and `integrity`, and whose source warns: *"Notably we currently don't consider non-standard (or future) options. This might not be safe. TODO: warn for non-standard extensions differing."* A GET with no signal is the one case where `options.signal` is absent from that key — which is exactly the `fetch_url` shape — so two same-URL GETs carrying different dispatchers could collapse into one. `undici` also cannot be scoped to the egress path: it enters the dependency tree and the server bundle, and its cross-instance dispatch against Node's built-in `fetch` works only because the package version happens to match the one Node bundles (6.28.1 against 6.28.0).

## Consequences

The repository now owns what `fetch` provided for free: undici's default request headers (`accept: */*`, `accept-language: *`, `sec-fetch-mode: cors`, `accept-encoding: gzip, deflate`), transparent decompression via `node:zlib`, the redirect loop's method-rewrite and cross-origin header-stripping rules, and an explicit connect timer, because Node's HTTP client has no connect timeout. One behaviour changes observably: a redirect that leaves the allowlist, or that targets a private address, now fails instead of succeeding — that is the hole this closes, not a regression.

Findings and the executed evidence: `docs/research/tool-egress-hardening.md` (PR #138).
