import { describe, expect, it } from "vitest";
import {
  assertEgressTarget,
  isHostAllowed,
  isHostListed,
  isPrivateAddress,
  parseEgressEntry,
  selectAllowedAddresses,
  EgressDeniedError,
  EMPTY_EGRESS_POLICY
} from "@/server/security/egress-policy";

describe("parseEgressEntry", () => {
  it("accepts an exact host with an optional port", () => {
    expect(parseEgressEntry("nas.local:8123")).toEqual({
      ok: true,
      entry: { host: "nas.local", port: "8123" }
    });
    expect(parseEgressEntry("10.0.0.42")).toEqual({
      ok: true,
      entry: { host: "10.0.0.42" }
    });
    expect(parseEgressEntry("[::1]:8123")).toEqual({
      ok: true,
      entry: { host: "::1", port: "8123" }
    });
  });

  it("refuses ranges, wildcards, and URLs", () => {
    expect(parseEgressEntry("10.0.0.0/8").ok).toBe(false);
    expect(parseEgressEntry("*.local").ok).toBe(false);
    expect(parseEgressEntry("http://nas.local:8123/").ok).toBe(false);
    expect(parseEgressEntry("").ok).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("classifies the ranges that must not be reached unlisted", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.10",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0"
    ]) {
      expect(isPrivateAddress(address, 4), address).toBe(true);
    }
  });

  it("leaves public addresses and the edges of private ranges alone", () => {
    for (const address of ["8.8.8.8", "172.32.0.0", "192.169.0.1", "100.128.0.1"]) {
      expect(isPrivateAddress(address, 4), address).toBe(false);
    }
  });

  it("reads IPv4-mapped and link-local IPv6", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isPrivateAddress("::1", 6)).toBe(true);
    expect(isPrivateAddress("fd00::1", 6)).toBe(true);
    expect(isPrivateAddress("fe80::1", 6)).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111", 6)).toBe(false);
  });
});

describe("assertEgressTarget", () => {
  const policy = { allowedHosts: ["localhost"] };

  it("lets a public host through without being listed", () => {
    expect(assertEgressTarget("https://example.com/a", EMPTY_EGRESS_POLICY).host).toBe(
      "example.com"
    );
  });

  it("refuses local names and literal private addresses", () => {
    expect(() => assertEgressTarget("http://localhost/", EMPTY_EGRESS_POLICY)).toThrow(
      "Local network URLs are not allowed"
    );
    expect(() => assertEgressTarget("http://nas.local/", EMPTY_EGRESS_POLICY)).toThrow(
      "Local network URLs are not allowed"
    );
    expect(() => assertEgressTarget("http://192.168.1.1/doc", EMPTY_EGRESS_POLICY)).toThrow(
      "Private network URLs are not allowed"
    );
  });

  it("keeps the literal check load-bearing even when the name is allowed", () => {
    expect(() => assertEgressTarget("http://127.0.0.1:8080/", policy)).toThrow(
      "Private network URLs are not allowed"
    );
  });

  it("honours the port on an entry", () => {
    expect(isHostAllowed({ allowedHosts: ["nas.local:8123"] }, "nas.local", "8123")).toBe(true);
    expect(isHostAllowed({ allowedHosts: ["nas.local:8123"] }, "nas.local", "9999")).toBe(false);
    expect(isHostAllowed({ allowedHosts: ["nas.local"] }, "nas.local", "9999")).toBe(true);
  });

  it("refuses anything that is not HTTP or HTTPS", () => {
    expect(() => assertEgressTarget("ftp://example.com/", EMPTY_EGRESS_POLICY)).toThrow(
      "Only HTTP and HTTPS URLs are allowed"
    );
  });
});

describe("selectAllowedAddresses", () => {
  const mixed = [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 }
  ];

  it("drops the private half of a split answer", () => {
    expect(selectAllowedAddresses(mixed, "split.test", EMPTY_EGRESS_POLICY)).toEqual([
      { address: "93.184.216.34", family: 4 }
    ]);
  });

  it("keeps every address of a listed host", () => {
    expect(
      selectAllowedAddresses(mixed, "split.test", { allowedHosts: ["split.test:8123"] })
    ).toEqual(mixed);
  });

  it("lists a host whatever port its entry carries", () => {
    expect(isHostListed({ allowedHosts: ["nas.local:8123"] }, "nas.local")).toBe(true);
    expect(isHostListed({ allowedHosts: ["nas.local:8123"] }, "other.local")).toBe(false);
  });

  it("reports a refusal with the host it belongs to", () => {
    const error = new EgressDeniedError("nope", "nas.local", "http://nas.local/");
    expect(error.kind).toBe("egress_denied");
    expect(error.host).toBe("nas.local");
  });
});
