import { isIP } from "node:net";

export function assertSafeHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "::1"
  ) {
    throw new Error("Local network URLs are not allowed");
  }

  const version = isIP(hostname);
  if (version === 4) {
    const [first, second] = hostname.split(".").map(Number);
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      throw new Error("Private network URLs are not allowed");
    }
  }

  if (
    version === 6 &&
    (hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80"))
  ) {
    throw new Error("Private network URLs are not allowed");
  }

  return url;
}
