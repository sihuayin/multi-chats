import type { ProviderFailureKind } from "@/server/domain/types";

export type ProviderFailure = {
  kind: ProviderFailureKind;
  message: string;
  code?: string;
  retryAfterMs?: number;
  status?: number;
};

function normalizeRetryAfterMs(value?: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function normalizeStatus(value?: number): number | undefined {
  return value !== undefined &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined;
}

export class ProviderReliabilityError extends Error {
  readonly code: string;
  readonly kind: ProviderFailureKind;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderReliabilityError";
    this.kind = failure.kind;
    this.code = failure.code ?? `provider_${failure.kind}`;
    this.retryAfterMs = normalizeRetryAfterMs(failure.retryAfterMs);
    this.status = normalizeStatus(failure.status);
  }
}

function classifyProviderFailureKind(
  message: string,
  status?: number,
  code?: string
): ProviderFailureKind {
  const normalized = `${code ?? ""} ${message}`.toLowerCase();
  if (
    /(insufficient_quota|quota exceeded|out of budget|billing|payment required)/.test(
      normalized
    )
  ) {
    return "terminal";
  }
  if (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 429
  ) {
    return "terminal";
  }
  if (
    status === 408 ||
    status === 504 ||
    /\b(408|504|timeout|timed out|deadline exceeded)\b/.test(normalized)
  ) {
    return "timeout";
  }
  if (
    status === 429 ||
    /(\b429\b|rate.?limit|too many requests|overloaded|resource.?exhausted)/.test(
      normalized
    )
  ) {
    return "rate_limited";
  }
  if (/(abort|cancel)/.test(normalized)) {
    return "cancelled";
  }
  if (
    status === 409 ||
    (status !== undefined && status >= 500) ||
    /(\b(409|500|502|503|524|529)\b|connection|network|socket|fetch failed|getaddrinfo|econnreset|eai_again|service.?unavailable|server.?error|internal.?error|upstream|stream ended|ended without)/.test(
      normalized
    )
  ) {
    return "retryable";
  }
  if (
    (status !== undefined && status >= 400 && status < 500) ||
    /(\b(400|401|403|404|422)\b|invalid.?request|unauthorized|forbidden)/.test(
      normalized
    )
  ) {
    return "terminal";
  }
  return "unknown";
}

export function classifyProviderFailure(input: {
  message: string;
  kind?: ProviderFailureKind;
  code?: string;
  retryAfterMs?: number;
  status?: number;
}): ProviderFailure {
  if (input.kind) {
    return {
      kind: input.kind,
      message: input.message,
      code: input.code,
      retryAfterMs: normalizeRetryAfterMs(input.retryAfterMs),
      status: normalizeStatus(input.status)
    };
  }
  return {
    kind: classifyProviderFailureKind(
      input.message,
      input.status,
      input.code
    ),
    message: input.message,
    code: input.code,
    retryAfterMs: normalizeRetryAfterMs(input.retryAfterMs),
    status: normalizeStatus(input.status)
  };
}

export function retryDelayMs(input: {
  attempt: number;
  kind?: ProviderFailureKind;
  retryAfterMs?: number;
  random?: () => number;
}): number {
  const base = Math.min(
    8_000,
    500 * 2 ** Math.max(0, input.attempt - 1)
  );
  const jitter = Math.floor(
    (input.random ?? Math.random)() * Math.min(250, base * 0.2)
  );
  const backoff = base + jitter;
  if (input.retryAfterMs !== undefined) {
    return Math.max(0, input.retryAfterMs, backoff);
  }
  return backoff;
}

export function retryAfterMsFromHeaders(
  headers: Record<string, string>,
  now = Date.now()
): number | undefined {
  const entries = new Map(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      value
    ])
  );
  const millisecondsValue = entries.get("retry-after-ms");
  if (millisecondsValue?.trim()) {
    const milliseconds = Number(millisecondsValue);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
      return Math.floor(milliseconds);
    }
  }
  const value = entries.get("retry-after");
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function shouldRetryProviderCall(input: {
  kind: ProviderFailureKind;
  attempt: number;
  maxAttempts: number;
  deadlineAt: number;
  now: number;
  producedOutput: boolean;
  sideEffectStarted: boolean;
  retryAfterMs?: number;
  random?: () => number;
}): {
  retry: boolean;
  delayMs: number;
  reason?:
    | "retry"
    | "terminal"
    | "visible_output"
    | "side_effect"
    | "attempts_exhausted"
    | "deadline_exceeded";
} {
  if (input.producedOutput) {
    return { retry: false, delayMs: 0, reason: "visible_output" };
  }
  if (input.sideEffectStarted) {
    return { retry: false, delayMs: 0, reason: "side_effect" };
  }
  if (
    ![
      "retryable",
      "rate_limited",
      "timeout",
      "malformed_output"
    ].includes(input.kind)
  ) {
    return { retry: false, delayMs: 0, reason: "terminal" };
  }
  if (input.attempt >= input.maxAttempts) {
    return { retry: false, delayMs: 0, reason: "attempts_exhausted" };
  }
  const delayMs = retryDelayMs({
    attempt: input.attempt,
    kind: input.kind,
    retryAfterMs: input.retryAfterMs,
    random: input.random
  });
  if (input.now + delayMs >= input.deadlineAt) {
    return {
      retry: false,
      delayMs,
      reason: "deadline_exceeded"
    };
  }
  return { retry: true, delayMs, reason: "retry" };
}
