import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import {
  assertEgressTarget,
  selectAllowedAddresses,
  EgressDeniedError,
  type EgressPolicy,
  type ResolvedAddress
} from "@/server/security/egress-policy";

/**
 * The one outbound HTTP path for Tool calls.
 *
 * `fetch` is deliberately not used: address pinning and `fetch` are mutually
 * exclusive in this runtime — `fetch(url, { lookup })` is silently ignored, and
 * a usable `Dispatcher` needs a dependency — so the address is pinned with a
 * custom `lookup` on an `http.Agent`. It also reproduces what `fetch` gave for
 * free: undici's default request headers, transparent decompression, and the
 * redirect algorithm. See `docs/adr/0001-tool-egress-transport.md`.
 */

/** Matches undici's default request headers, which servers can observe. */
const DEFAULT_HEADERS: Record<string, string> = {
  accept: "*/*",
  "accept-language": "*",
  "sec-fetch-mode": "cors",
  "accept-encoding": "gzip, deflate",
  connection: "keep-alive"
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type EgressInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: "follow" | "error" | "manual";
};

export type EgressFetch = (
  input: string | URL,
  init?: EgressInit
) => Promise<Response>;

export type EgressClient = EgressFetch & { destroy: () => void };

export type EgressClientOptions = {
  /** Read fresh on every request, so an allowlist edit takes effect at once. */
  resolvePolicy: () => EgressPolicy | Promise<EgressPolicy>;
  /** Injected so multi-address and redirect cases are reachable in tests. */
  lookup?: typeof dnsLookup;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxRedirects?: number;
  /** Bounds how long an idle socket may be reused, and so how long a stale
   *  socket can outlive the address it was validated against. */
  keepAliveMs?: number;
  userAgent?: string;
};

type RawResponse = {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

/**
 * The resolving half of the guard, as the `lookup` an `http.Agent` consults:
 * every address a hostname resolves to is classified before any connect, and a
 * host that is not allowlisted keeps only its public addresses.
 *
 * Exported so the multi-address case can be asserted without reaching a real
 * public address.
 */
export function createPinnedLookup(options: {
  resolvePolicy: () => EgressPolicy | Promise<EgressPolicy>;
  lookup?: typeof dnsLookup;
}): (
  hostname: string,
  lookupOptions: unknown,
  done: (...args: never[]) => void
) => void {
  const resolvePolicy = options.resolvePolicy;
  const lookupImpl = options.lookup ?? dnsLookup;

  return (hostname, lookupOptions, done) => {
    void (async () => {
      const policy = await resolvePolicy();
      const opts = (lookupOptions ?? {}) as { all?: boolean };
      lookupImpl(hostname, { ...opts, all: true }, (error, addresses) => {
        const callback = done as unknown as (...args: unknown[]) => void;
        if (error) {
          callback(error);
          return;
        }
        const list = (
          Array.isArray(addresses) ? addresses : [addresses]
        ) as ResolvedAddress[];
        const allowed = selectAllowedAddresses(list, hostname, policy);
        if (allowed.length === 0) {
          callback(
            new EgressDeniedError(
              "Private network URLs are not allowed",
              hostname,
              hostname
            )
          );
          return;
        }
        if (opts.all) callback(null, allowed);
        else callback(null, allowed[0].address, allowed[0].family);
      });
    })();
  };
}

export function createEgressClient(options: EgressClientOptions): EgressClient {
  const resolvePolicy = options.resolvePolicy;
  const lookupImpl = options.lookup ?? dnsLookup;
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 20;
  const keepAliveMs = options.keepAliveMs ?? 1_000;
  const userAgent = options.userAgent ?? "multi-chats/0.1";

  const pinnedLookup = createPinnedLookup({ resolvePolicy, lookup: lookupImpl });

  const agentOptions = {
    keepAlive: true,
    timeout: keepAliveMs,
    lookup: pinnedLookup
  } as unknown as http.AgentOptions;
  const httpAgent = new http.Agent(agentOptions);
  const httpsAgent = new https.Agent(agentOptions);

  function send(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(
        url,
        {
          method,
          headers,
          agent: url.protocol === "https:" ? httpsAgent : httpAgent,
          signal
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              statusText: response.statusMessage ?? "",
              headers: response.headers,
              body: Buffer.concat(chunks)
            })
          );
          response.on("error", reject);
        }
      );

      request.on("error", reject);
      // Node's HTTP client has no connect timeout: `setTimeout` does not fire
      // while connecting, so connect time is bounded by an explicit timer.
      request.on("socket", (socket) => {
        if (!socket.connecting) return;
        const timer = setTimeout(() => {
          request.destroy(new Error(`Timed out connecting to ${url.host}`));
        }, connectTimeoutMs);
        const clear = () => clearTimeout(timer);
        socket.once("connect", clear);
        socket.once("close", clear);
      });

      if (body !== undefined) request.write(body);
      request.end();
    });
  }

  function decode(buffer: Buffer, encoding: string | undefined): Buffer {
    const value = (encoding ?? "").split(",")[0].trim().toLowerCase();
    if (value === "gzip" || value === "x-gzip") return zlib.gunzipSync(buffer);
    if (value === "deflate") {
      try {
        return zlib.inflateSync(buffer);
      } catch {
        return zlib.inflateRawSync(buffer);
      }
    }
    if (value === "br") return zlib.brotliDecompressSync(buffer);
    return buffer;
  }

  function toBodyInit(buffer: Buffer): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(buffer);
    return copy;
  }

  function toResponse(raw: RawResponse): Response {
    const headers = new Headers();
    for (const [key, value] of Object.entries(raw.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        headers.append(key, item);
      }
    }
    const encoding =
      typeof raw.headers["content-encoding"] === "string"
        ? raw.headers["content-encoding"]
        : undefined;
    // 204/205/304 must not carry a body. The copy gives the response a
    // Uint8Array over a plain ArrayBuffer, which is what BodyInit accepts.
    const noBody = [204, 205, 304].includes(raw.status);
    const body = noBody ? null : toBodyInit(decode(raw.body, encoding));
    return new Response(body, {
      status: raw.status,
      statusText: raw.statusText,
      headers
    });
  }

  const egressFetch = (async (
    input: string | URL,
    init: EgressInit = {}
  ): Promise<Response> => {
    let url = input instanceof URL ? input : new URL(input);
    let method = init.method ?? "GET";
    let body = init.body;
    const headers: Record<string, string> = {
      ...DEFAULT_HEADERS,
      "user-agent": userAgent,
      ...init.headers
    };
    const redirect = init.redirect ?? "follow";
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs);

    for (let hop = 0; ; hop += 1) {
      // Re-validated on every hop, with the same function as the first.
      assertEgressTarget(url, await resolvePolicy());
      const raw = await send(url, method, headers, body, signal);

      if (!REDIRECT_STATUSES.has(raw.status)) return toResponse(raw);
      if (redirect === "manual") return toResponse(raw);
      if (redirect === "error") throw new TypeError("fetch failed");

      const location = raw.headers.location;
      if (!location) return toResponse(raw);
      if (hop >= maxRedirects) throw new TypeError("redirect count exceeded");

      const next = new URL(location, url);
      if (!["http:", "https:"].includes(next.protocol)) {
        throw new TypeError("fetch failed");
      }
      if (
        ((raw.status === 301 || raw.status === 302) && method === "POST") ||
        (raw.status === 303 && method !== "GET" && method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
      }
      if (next.origin !== url.origin) {
        delete headers.authorization;
        delete headers["proxy-authorization"];
        delete headers.cookie;
        delete headers.host;
      }
      url = next;
    }
  }) as EgressClient;

  egressFetch.destroy = () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  };

  return egressFetch;
}
