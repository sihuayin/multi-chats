import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  retryDelayMs,
  retryAfterMsFromHeaders,
  shouldFailoverProviderCall,
  shouldRetryProviderCall
} from "@/server/application/provider-reliability";

describe("Provider reliability policy", () => {
  it("normalizes every Provider failure category", () => {
    expect(
      classifyProviderFailure({
        message: "request rejected",
        kind: "terminal"
      }).kind
    ).toBe("terminal");
    expect(
      classifyProviderFailure({
        message: "unexpected provider response"
      }).kind
    ).toBe("unknown");
    expect(
      classifyProviderFailure({
        message: "request rejected",
        status: 401
      }).kind
    ).toBe("terminal");
    expect(
      classifyProviderFailure({
        message: "socket closed"
      })
    ).toMatchObject({
      kind: "retryable",
      ambiguous: true
    });
    expect(
      classifyProviderFailure({
        message: "connection refused"
      })
    ).toMatchObject({
      kind: "retryable",
      ambiguous: undefined
    });
    expect(
      classifyProviderFailure({
        message: "temporarily unavailable",
        status: 503
      }).kind
    ).toBe("retryable");
    expect(
      classifyProviderFailure({
        message: "503: upstream unavailable"
      }).kind
    ).toBe("retryable");
    expect(
      classifyProviderFailure({
        message: "rate limited",
        status: 429,
        retryAfterMs: 1_000
      }).kind
    ).toBe("rate_limited");
    expect(
      classifyProviderFailure({
        message: "429: too many requests"
      }).kind
    ).toBe("rate_limited");
    expect(
      classifyProviderFailure({
        message: "quota exceeded",
        status: 429,
        code: "insufficient_quota"
      }).kind
    ).toBe("terminal");
    expect(
      classifyProviderFailure({
        message: "connection refused",
        status: 400
      }).kind
    ).toBe("terminal");
    expect(
      classifyProviderFailure({
        message: "request timed out"
      }).kind
    ).toBe("timeout");
    expect(
      classifyProviderFailure({
        message: "The operation was aborted"
      }).kind
    ).toBe("cancelled");
    expect(
      classifyProviderFailure({
        message: "Discussion Turn response is not JSON",
        kind: "malformed_output"
      }).kind
    ).toBe("malformed_output");
  });

  it("uses bounded exponential backoff with jitter", () => {
    expect(retryDelayMs({ attempt: 1, random: () => 0 })).toBe(500);
    expect(retryDelayMs({ attempt: 2, random: () => 0 })).toBe(1_000);
    expect(
      retryDelayMs({
        attempt: 1,
        kind: "rate_limited",
        retryAfterMs: 5_000,
        random: () => 0
      })
    ).toBe(5_000);
    expect(
      retryDelayMs({
        attempt: 1,
        kind: "rate_limited",
        retryAfterMs: 100,
        random: () => 0
      })
    ).toBe(500);
  });

  it("reads Retry-After headers in milliseconds, seconds, and date form", () => {
    expect(
      retryAfterMsFromHeaders({ "retry-after-ms": "1250" })
    ).toBe(1_250);
    expect(
      retryAfterMsFromHeaders({ "Retry-After": "3" })
    ).toBe(3_000);
    expect(
      retryAfterMsFromHeaders(
        { "retry-after": "Mon, 14 Sep 2026 10:00:10 GMT" },
        Date.parse("Mon, 14 Sep 2026 10:00:00 GMT")
      )
    ).toBe(10_000);
  });

  it("does not retry after visible output or a Tool side effect", () => {
    expect(
      shouldRetryProviderCall({
        kind: "retryable",
        attempt: 1,
        maxAttempts: 3,
        deadlineAt: 10_000,
        now: 0,
        producedOutput: true,
        sideEffectStarted: false
      }).retry
    ).toBe(false);
    expect(
      shouldRetryProviderCall({
        kind: "unknown",
        attempt: 1,
        maxAttempts: 3,
        deadlineAt: 10_000,
        now: 0,
        producedOutput: false,
        sideEffectStarted: false,
        ambiguous: true
      })
    ).toMatchObject({ retry: false, reason: "ambiguous" });
    expect(
      shouldRetryProviderCall({
        kind: "retryable",
        attempt: 1,
        maxAttempts: 3,
        deadlineAt: 10_000,
        now: 0,
        producedOutput: false,
        sideEffectStarted: true
      }).retry
    ).toBe(false);
  });

  it("retries malformed structured output while attempts remain", () => {
    expect(
      shouldRetryProviderCall({
        kind: "malformed_output",
        attempt: 1,
        maxAttempts: 2,
        deadlineAt: 10_000,
        now: 0,
        producedOutput: false,
        sideEffectStarted: false,
        random: () => 0
      })
    ).toMatchObject({ retry: true, delayMs: 500 });
    expect(
      shouldRetryProviderCall({
        kind: "malformed_output",
        attempt: 2,
        maxAttempts: 2,
        deadlineAt: 10_000,
        now: 0,
        producedOutput: false,
        sideEffectStarted: false
      }).retry
    ).toBe(false);
    expect(
      shouldRetryProviderCall({
        kind: "malformed_output",
        attempt: 1,
        maxAttempts: 1,
        deadlineAt: 10_000,
        now: 0,
        producedOutput: false,
        sideEffectStarted: false
      }).retry
    ).toBe(false);
  });

  it("obeys attempt and deadline limits", () => {
    expect(
      shouldRetryProviderCall({
        kind: "timeout",
        attempt: 3,
        maxAttempts: 3,
        deadlineAt: 10_000,
        now: 0,
        producedOutput: false,
        sideEffectStarted: false
      }).retry
    ).toBe(false);
    expect(
      shouldRetryProviderCall({
        kind: "timeout",
        attempt: 1,
        maxAttempts: 3,
        deadlineAt: 100,
        now: 90,
        producedOutput: false,
        sideEffectStarted: false
      })
    ).toMatchObject({
      retry: false,
      reason: "deadline_exceeded"
    });
  });

  it("fails over only while another target is safe to try", () => {
    expect(
      shouldFailoverProviderCall({
        kind: "retryable",
        hasNextTarget: true,
        producedOutput: false,
        sideEffectStarted: false,
        cancelled: false,
        deadlineExceeded: false
      })
    ).toMatchObject({ failover: true, reason: "failover" });
    expect(
      shouldFailoverProviderCall({
        kind: "terminal",
        hasNextTarget: true,
        producedOutput: false,
        sideEffectStarted: false,
        cancelled: false,
        deadlineExceeded: false
      }).failover
    ).toBe(true);
    expect(
      shouldFailoverProviderCall({
        kind: "retryable",
        hasNextTarget: true,
        producedOutput: true,
        sideEffectStarted: false,
        cancelled: false,
        deadlineExceeded: false
      })
    ).toMatchObject({ failover: false, reason: "visible_output" });
    expect(
      shouldFailoverProviderCall({
        kind: "retryable",
        hasNextTarget: true,
        producedOutput: false,
        sideEffectStarted: true,
        cancelled: false,
        deadlineExceeded: false
      })
    ).toMatchObject({ failover: false, reason: "side_effect" });
    expect(
      shouldFailoverProviderCall({
        kind: "cancelled",
        hasNextTarget: true,
        producedOutput: false,
        sideEffectStarted: false,
        cancelled: true,
        deadlineExceeded: false
      }).failover
    ).toBe(false);
    expect(
      shouldFailoverProviderCall({
        kind: "timeout",
        hasNextTarget: true,
        producedOutput: false,
        sideEffectStarted: false,
        cancelled: false,
        deadlineExceeded: true
      }).failover
    ).toBe(false);
    expect(
      shouldFailoverProviderCall({
        kind: "unknown",
        hasNextTarget: true,
        producedOutput: false,
        sideEffectStarted: false,
        cancelled: false,
        ambiguous: true,
        deadlineExceeded: false
      })
    ).toMatchObject({ failover: false, reason: "ambiguous" });
    expect(
      shouldFailoverProviderCall({
        kind: "retryable",
        hasNextTarget: false,
        producedOutput: false,
        sideEffectStarted: false,
        cancelled: false,
        deadlineExceeded: false
      })
    ).toMatchObject({ failover: false, reason: "targets_exhausted" });
  });
});
