import { isIP } from "node:net";

/**
 * The Workspace egress policy, and the address classification every outbound
 * Tool call is measured against.
 *
 * The policy governs the **private** space only: public hosts are reachable
 * without being listed, while private, loopback, link-local, and `.local`
 * addresses are denied unless the exact host is listed. See
 * `docs/adr/0001-tool-egress-transport.md`.
 */

export type EgressPolicy = {
  /**
   * Exact hosts, optionally with a port, that may resolve to a private
   * address. An entry without a port matches that host on any port; an entry
   * with a port matches only that port.
   */
  allowedHosts: string[];
};

export const EMPTY_EGRESS_POLICY: EgressPolicy = { allowedHosts: [] };

/**
 * A refusal. Carries the host and URL so a caller can say which call was
 * refused and why rather than only that something was.
 */
export class EgressDeniedError extends Error {
  readonly kind = "egress_denied";

  constructor(
    message: string,
    readonly host: string,
    readonly url: string
  ) {
    super(message);
    this.name = "EgressDeniedError";
  }
}

export type ParsedHostEntry = { host: string; port?: string };

/**
 * Parse an operator-entered allowlist entry. Ranges and wildcards are refused:
 * an operator can write `nas.local:8123` correctly and cannot reliably write
 * the boundary of `10.0.0.0/8`, and a wrong boundary reads as isolation that is
 * not there.
 */
export function parseEgressEntry(
  raw: string
): { ok: true; entry: ParsedHostEntry } | { ok: false; reason: string } {
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: false, reason: "Enter a host." };
  if (value.includes("://")) {
    return { ok: false, reason: "Enter a host, not a URL." };
  }
  if (/[/?*]/.test(value)) {
    return {
      ok: false,
      reason: "Exact hosts only — ranges and wildcards are not supported."
    };
  }

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    return { ok: true, entry: entryOf(bracketed[1], bracketed[2]) };
  }

  const parts = value.split(":");
  if (parts.length > 2) {
    return { ok: false, reason: "Enter one host with an optional port." };
  }
  const [host, port] = parts;
  if (isIP(host) === 6) {
    return { ok: false, reason: "Wrap an IPv6 host in brackets, like [::1]:8123." };
  }
  return { ok: true, entry: entryOf(host, port) };
}

function entryOf(
  hostInput: string,
  portInput?: string
): ParsedHostEntry {
  const host = hostInput.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error("Enter a host.");
  if (portInput === undefined || portInput === "") return { host };
  if (!/^\d+$/.test(portInput)) throw new Error("A port must be a number.");
  return { host, port: portInput };
}

export function formatEgressEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

/** Does one allowlist entry cover this host and port? */
export function entryMatches(
  entry: string,
  hostname: string,
  port: string
): boolean {
  const parsed = parseEgressEntry(entry);
  if (!parsed.ok) return false;
  if (parsed.entry.host !== hostname.toLowerCase()) return false;
  return parsed.entry.port === undefined || parsed.entry.port === port;
}

export function isHostAllowed(
  policy: EgressPolicy,
  hostname: string,
  port: string
): boolean {
  return policy.allowedHosts.some((entry) =>
    entryMatches(entry, hostname, port)
  );
}

/**
 * Is this host listed at all, whatever port? Used when deciding whether a
 * resolved private address may be connected to: the port rule has already been
 * enforced by `assertEgressTarget`, and resolution is not told the port.
 */
export function isHostListed(policy: EgressPolicy, hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return policy.allowedHosts.some((entry) => {
    const parsed = parseEgressEntry(entry);
    return parsed.ok && parsed.entry.host === bare;
  });
}

/** True for anything that must not be reached without an explicit allowance. */
export function isPrivateAddress(address: string, family: number): boolean {
  if (family === 6) {
    const value = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (value === "::" || value === "::1") return true;
    if (
      value.startsWith("fe80") ||
      value.startsWith("fc") ||
      value.startsWith("fd")
    ) {
      return true;
    }
    return false;
  }
  return isPrivateIPv4(address);
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  // Anything we cannot read as a plain dotted quad is treated as private.
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isLocalName(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".local");
}

/**
 * The syntactic half of the guard, made allowlist-aware. A host on the
 * allowlist skips the literal checks entirely; everything else is refused if it
 * is a local name, a literal private address, or not HTTP(S).
 *
 * This stays load-bearing next to the resolving `lookup`: `net.connect` skips
 * resolution for IP literals, so a literal private address never reaches the
 * lookup at all.
 */
export function assertEgressTarget(
  value: string | URL,
  policy: EgressPolicy
): URL {
  const url = value instanceof URL ? value : new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new EgressDeniedError(
      "Only HTTP and HTTPS URLs are allowed",
      url.hostname,
      url.toString()
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");

  if (isHostAllowed(policy, hostname, port)) return url;

  if (isLocalName(hostname)) {
    throw new EgressDeniedError(
      "Local network URLs are not allowed",
      hostname,
      url.toString()
    );
  }
  const version = isIP(hostname);
  if (version !== 0 && isPrivateAddress(hostname, version)) {
    throw new EgressDeniedError(
      "Private network URLs are not allowed",
      hostname,
      url.toString()
    );
  }
  return url;
}

export type ResolvedAddress = { address: string; family: number };

/**
 * The resolving half. An allowlisted host keeps every address it resolves to; a
 * host that is not allowlisted keeps only its public ones, so a split answer
 * cannot smuggle a call inward.
 */
export function selectAllowedAddresses(
  addresses: ResolvedAddress[],
  hostname: string,
  policy: EgressPolicy
): ResolvedAddress[] {
  if (isHostListed(policy, hostname)) return addresses;
  return addresses.filter(
    (item) => !isPrivateAddress(item.address, item.family)
  );
}
