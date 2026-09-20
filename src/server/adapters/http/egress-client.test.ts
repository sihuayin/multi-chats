import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEgressClient,
  createPinnedLookup
} from "@/server/adapters/http/egress-client";
import {
  EgressDeniedError,
  EMPTY_EGRESS_POLICY,
  type EgressPolicy
} from "@/server/security/egress-policy";

const open: Array<() => Promise<void>> = [];

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ origin: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  open.push(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  );
  return { origin: `http://localhost:${port}`, port };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.();
});

function client(policy: EgressPolicy, lookup?: Parameters<typeof createPinnedLookup>[0]["lookup"]) {
  return createEgressClient({
    resolvePolicy: () => policy,
    ...(lookup ? { lookup } : {}),
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 5_000
  });
}

describe("egress client", () => {
  it("refuses a host whose every resolved address is private and unlisted", async () => {
    const egress = client(EMPTY_EGRESS_POLICY, (async (
      _hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses?: unknown) => void
    ) => {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as never);

    await expect(egress("http://internal.test:9/")).rejects.toThrow(
      "Private network URLs are not allowed"
    );
  });

  it("reaches an allowlisted fixture server on localhost", async () => {
    const seen: string[] = [];
    const { origin } = await fixture((request, response) => {
      seen.push(`${request.method ?? ""} ${request.url ?? ""}`);
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("hello from the fixture");
    });

    const response = await client({ allowedHosts: ["localhost"] })(`${origin}/doc`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from the fixture");
    expect(seen).toEqual(["GET /doc"]);
  });

  it("sends the headers undici would have sent", async () => {
    let received: IncomingMessage["headers"] = {};
    const { origin } = await fixture((request, response) => {
      received = request.headers;
      response.writeHead(200);
      response.end("ok");
    });

    await client({ allowedHosts: ["localhost"] })(`${origin}/`);
    expect(received.accept).toBe("*/*");
    expect(received["accept-encoding"]).toBe("gzip, deflate");
    expect(received["user-agent"]).toBe("multi-chats/0.1");
  });

  it("decodes a gzip response transparently", async () => {
    const { origin } = await fixture((_request, response) => {
      response.writeHead(200, { "content-encoding": "gzip" });
      response.end(gzipSync("compressed body"));
    });

    const response = await client({ allowedHosts: ["localhost"] })(`${origin}/`);
    expect(await response.text()).toBe("compressed body");
  });

  it("returns a non-2xx response rather than throwing", async () => {
    const { origin } = await fixture((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("no such thing");
    });

    const response = await client({ allowedHosts: ["localhost"] })(`${origin}/missing`);
    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
  });

  it("follows a redirect that stays inside the allowlist", async () => {
    const target = await fixture((_request, response) => {
      response.writeHead(200);
      response.end("landed");
    });
    const start = await fixture((_request, response) => {
      response.writeHead(302, { location: `${target.origin}/landed` });
      response.end();
    });

    const response = await client({ allowedHosts: ["localhost"] })(`${start.origin}/go`);
    expect(await response.text()).toBe("landed");
  });

  it("refuses a redirect that leaves the allowlist, without connecting", async () => {
    let requests = 0;
    const { origin } = await fixture((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: "http://10.0.0.5:9/inside" });
      response.end();
    });

    await expect(
      client({ allowedHosts: ["localhost"] })(`${origin}/go`)
    ).rejects.toThrow("Private network URLs are not allowed");
    expect(requests).toBe(1);
  });

  it("refuses a literal private address even when its name is allowed", async () => {
    let requests = 0;
    const { port } = await fixture((_request, response) => {
      requests += 1;
      response.writeHead(200);
      response.end("should not be reached");
    });

    await expect(
      client({ allowedHosts: ["localhost"] })(`http://127.0.0.1:${port}/`)
    ).rejects.toThrow("Private network URLs are not allowed");
    expect(requests).toBe(0);
  });
});

describe("pinned lookup", () => {
  const mixed = [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 }
  ];

  function lookupReturning(addresses: unknown) {
    return (async (
      _hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses?: unknown) => void
    ) => {
      callback(null, addresses);
    }) as never;
  }

  it("drops the private half of a split answer before any connect", async () => {
    const pinned = createPinnedLookup({
      resolvePolicy: () => EMPTY_EGRESS_POLICY,
      lookup: lookupReturning(mixed)
    });

    const addresses = await new Promise((resolve, reject) =>
      pinned("split.test", { all: true }, ((error: Error | null, value: unknown) =>
        error ? reject(error) : resolve(value)) as never)
    );
    expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("keeps every address when the host is listed", async () => {
    const pinned = createPinnedLookup({
      resolvePolicy: () => ({ allowedHosts: ["split.test:8123"] }),
      lookup: lookupReturning(mixed)
    });

    const addresses = await new Promise((resolve, reject) =>
      pinned("split.test", { all: true }, ((error: Error | null, value: unknown) =>
        error ? reject(error) : resolve(value)) as never)
    );
    expect(addresses).toEqual(mixed);
  });

  it("denies when nothing survives the filter", async () => {
    const pinned = createPinnedLookup({
      resolvePolicy: () => EMPTY_EGRESS_POLICY,
      lookup: lookupReturning([{ address: "::ffff:127.0.0.1", family: 6 }])
    });

    const error = await new Promise((resolve) =>
      pinned("split.test", { all: true }, ((value: unknown) => resolve(value)) as never)
    );
    expect(error).toBeInstanceOf(EgressDeniedError);
  });

  it("honours a single-address caller", async () => {
    const pinned = createPinnedLookup({
      resolvePolicy: () => EMPTY_EGRESS_POLICY,
      lookup: lookupReturning(mixed)
    });

    const result = await new Promise((resolve) =>
      pinned("split.test", { all: false }, ((_error: unknown, address: unknown, family: unknown) =>
        resolve({ address, family })) as never)
    );
    expect(result).toEqual({ address: "93.184.216.34", family: 4 });
  });
});
