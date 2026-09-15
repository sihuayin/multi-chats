import { describe, expect, it } from "vitest";
import {
  PROVIDER_SMOKE_SCENARIO_SPECS,
  ProviderSmokeConfigError,
  assertProviderSmokeReportOmitsCredentials,
  providerSmokeGateInput,
  redactProviderSmokeReport,
  resolveProviderSmokeConfig,
  runProviderSmokeMatrix,
  validateProviderSmokeReport,
  type ProviderSmokeReport,
  type ProviderSmokeRunConfig,
  type ProviderSmokeScenarioExecutor
} from "@/server/application/provider-smoke";
import {
  PROVIDER_SMOKE_TEST_ENV,
  resolveProviderSmokeTestConfig
} from "@/server/test-support/provider-smoke-gateway";

function config(): ProviderSmokeRunConfig {
  return resolveProviderSmokeTestConfig();
}

const executor: ProviderSmokeScenarioExecutor = async ({ scenario }) => ({
  status: "passed",
  attempts: [
    {
      provider: "openai",
      modelId: "gpt-4o-mini",
      targetOrder: 0,
      attempt: 1,
      status: "succeeded",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        source: "provider"
      },
      estimatedCostMicros: 20
    }
  ],
  artifactLinks: ["artifact://provider-smoke/artifact-1"],
  detail: { scenario }
});

async function report(
  overrides: Partial<ProviderSmokeRunConfig> = {},
  run: ProviderSmokeScenarioExecutor = executor
): Promise<ProviderSmokeReport> {
  return runProviderSmokeMatrix({
    config: { ...config(), ...overrides },
    executor: run,
    clock: () => "2026-01-01T00:00:00.000Z"
  });
}

describe("Provider smoke configuration", () => {
  it("skips without an explicit opt-in", () => {
    const resolved = resolveProviderSmokeConfig({});
    expect(resolved).toMatchObject({ enabled: false });
    expect(
      resolved.enabled ? "" : resolved.skippedReason
    ).toContain("opt-in");
  });

  it("rejects a partial primary target instead of skipping silently", () => {
    expect(() =>
      resolveProviderSmokeConfig({
        PROVIDER_SMOKE: "1",
        SMOKE_PRIMARY_PROVIDER: "openai"
      })
    ).toThrow(ProviderSmokeConfigError);
  });

  it("requires a failover pair to cover every required Provider family", () => {
    expect(() =>
      resolveProviderSmokeConfig({
        PROVIDER_SMOKE: "1",
        SMOKE_PRIMARY_PROVIDER: "openai",
        SMOKE_PRIMARY_MODEL: "gpt-4o-mini",
        SMOKE_PRIMARY_API_KEY: "test-key-primary",
        SMOKE_FALLBACK_PROVIDER: "openrouter",
        SMOKE_FALLBACK_MODEL: "openai/gpt-4o-mini",
        SMOKE_FALLBACK_API_KEY: "test-key-fallback"
      })
    ).toThrow(/anthropic/);
  });

  it("runs with a single OpenAI-compatible target when it is the only credential", () => {
    expect(
      resolveProviderSmokeConfig({
        PROVIDER_SMOKE: "1",
        SMOKE_PRIMARY_PROVIDER: "openai",
        SMOKE_PRIMARY_MODEL: "gpt-4o-mini",
        SMOKE_PRIMARY_API_KEY: "test-key-primary"
      })
    ).toMatchObject({
      enabled: true,
      targets: [{ role: "primary", provider: "openai" }]
    });
  });

  it("resolves targets and bounded limits from the environment", () => {
    expect(config()).toMatchObject({
      enabled: true,
      targets: [
        { role: "primary", provider: "openai", modelId: "gpt-4o-mini" },
        { role: "fallback", provider: "anthropic", modelId: "claude-3-5-haiku" }
      ],
      limits: {
        maxTotalTokens: 20_000,
        maxCostMicros: 500_000,
        timeoutMs: 30_000
      }
    });
  });

  it("rejects a non-numeric cap", () => {
    expect(() =>
      resolveProviderSmokeConfig({
        ...PROVIDER_SMOKE_TEST_ENV,
        SMOKE_MAX_TOTAL_TOKENS: "lots"
      })
    ).toThrow(ProviderSmokeConfigError);
  });

  it("defaults pricing and lets the environment override it", () => {
    expect(config().pricing).toEqual({
      inputMicrosPerMillionTokens: 3_000_000,
      outputMicrosPerMillionTokens: 15_000_000
    });
    expect(
      resolveProviderSmokeConfig({
        ...PROVIDER_SMOKE_TEST_ENV,
        SMOKE_INPUT_MICROS_PER_MILLION_TOKENS: "1000",
        SMOKE_OUTPUT_MICROS_PER_MILLION_TOKENS: "2000"
      })
    ).toMatchObject({
      enabled: true,
      pricing: {
        inputMicrosPerMillionTokens: 1000,
        outputMicrosPerMillionTokens: 2000
      }
    });
  });
});

describe("Provider smoke matrix", () => {
  it("runs every scenario and aggregates usage and cost", async () => {
    const result = await report();
    expect(result.scenarios.map((scenario) => scenario.scenario)).toEqual(
      PROVIDER_SMOKE_SCENARIO_SPECS.map((spec) => spec.scenario)
    );
    expect(result.totals.attempts).toBe(PROVIDER_SMOKE_SCENARIO_SPECS.length);
    expect(result.totals.usage).toMatchObject({
      inputTokens: 10 * PROVIDER_SMOKE_SCENARIO_SPECS.length,
      totalTokens: 15 * PROVIDER_SMOKE_SCENARIO_SPECS.length,
      source: "provider"
    });
    expect(result.totals.estimatedCostMicros).toBe(
      20 * PROVIDER_SMOKE_SCENARIO_SPECS.length
    );
    expect(result.passed).toBe(true);
    expect(() => validateProviderSmokeReport(result)).not.toThrow();
  });

  it("skips the failover scenario when no fallback target is configured", async () => {
    const result = await runProviderSmokeMatrix({
      config: {
        enabled: true,
        targets: [
          {
            role: "primary",
            provider: "openai",
            modelId: "gpt-4o-mini",
            credential: "test-key-primary"
          }
        ],
        limits: config().limits,
        pricing: config().pricing
      },
      executor,
      clock: () => "2026-01-01T00:00:00.000Z"
    });
    expect(
      result.scenarios.find((scenario) => scenario.scenario === "failover")
    ).toMatchObject({
      status: "skipped",
      reason: "No fallback target is configured."
    });
    expect(() => validateProviderSmokeReport(result)).not.toThrow();
  });

  it("stops remaining scenarios once a cap is reached", async () => {
    const result = await report({
      limits: { maxTotalTokens: 20, maxCostMicros: 500_000, timeoutMs: 30_000 }
    });
    expect(result.totals.capReached).toBe(true);
    expect(result.passed).toBe(false);
    expect(
      result.scenarios.filter((scenario) => scenario.status === "skipped").length
    ).toBeGreaterThan(0);
    expect(() => validateProviderSmokeReport(result)).not.toThrow();
  });

  it("stops remaining scenarios once the cost cap is reached", async () => {
    // Every stub attempt costs 20 micros, so a 20-micro cost cap trips after
    // the first scenario without the token cap ever binding.
    const result = await report({
      limits: { maxTotalTokens: 20_000, maxCostMicros: 20, timeoutMs: 30_000 }
    });
    expect(result.totals.estimatedCostMicros).not.toBeNull();
    expect(result.totals.capReached).toBe(true);
    expect(result.passed).toBe(false);
    expect(
      result.scenarios.filter((scenario) => scenario.status === "skipped").length
    ).toBeGreaterThan(0);
    expect(() => validateProviderSmokeReport(result)).not.toThrow();
  });

  it("fails the matrix when a scenario fails", async () => {
    const result = await report({}, async ({ scenario }) =>
      scenario === "retry"
        ? { status: "failed", reason: "no retry observed", attempts: [] }
        : executor({ scenario, config: config(), primary: config().targets[0] })
    );
    expect(result.passed).toBe(false);
    expect(() => validateProviderSmokeReport(result)).toThrow(/retry/);
  });
});

describe("Provider smoke report validation", () => {
  it("rejects a report that drops a scenario", async () => {
    const result = await report();
    const withoutRetry: ProviderSmokeReport = {
      ...result,
      scenarios: result.scenarios.filter(
        (scenario) => scenario.scenario !== "retry"
      )
    };
    expect(() => validateProviderSmokeReport(withoutRetry)).toThrow(
      /missing scenario retry/
    );
  });

  it("rejects a scenario that reports no Provider attempt", async () => {
    const result = await report({}, async () => ({
      status: "passed",
      attempts: []
    }));
    expect(() => validateProviderSmokeReport(result)).toThrow(
      /no Provider attempt/
    );
  });

  it("rejects a scenario without the artifact link it requires", async () => {
    const result = await report({}, async ({ scenario }) => ({
      status: "passed",
      attempts: (await executor({
        scenario,
        config: config(),
        primary: config().targets[0]
      })).attempts
    }));
    expect(() => validateProviderSmokeReport(result)).toThrow(
      /requires an artifact link/
    );
  });

  it("rejects totals that exceed the configured caps", async () => {
    const result = await report();
    expect(() =>
      validateProviderSmokeReport({
        ...result,
        limits: { ...result.limits, maxTotalTokens: 10 }
      })
    ).toThrow(/token cap/);
  });

  it("rejects a report that leaks a secret", async () => {
    const result = await report();
    const leaked = {
      ...result,
      scenarios: result.scenarios.map((scenario, index) =>
        index === 0
          ? { ...scenario, reason: "used sk-abcdefghijklmnop" }
          : scenario
      )
    };
    expect(() => validateProviderSmokeReport(leaked)).toThrow(/secret/);
  });

  it("rejects a pass flag that disagrees with its results", async () => {
    const result = await report();
    expect(() =>
      validateProviderSmokeReport({ ...result, passed: false })
    ).toThrow(/pass flag/);
  });
});

describe("Provider smoke redaction", () => {
  it("drops credential-shaped keys and redacts secret values", async () => {
    const result = await report();
    const redacted = redactProviderSmokeReport({
      ...result,
      scenarios: result.scenarios.map((scenario, index) =>
        index === 0
          ? {
              ...scenario,
              detail: { credential: "test-key-primary", note: "Bearer abc" }
            }
          : scenario
      )
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("test-key-primary");
    expect(serialized).not.toContain("Bearer abc");
    expect(serialized).toContain("[REDACTED]");
    expect(() => validateProviderSmokeReport(redacted)).not.toThrow();
  });

  it("shapes the report as opt-in release evidence", async () => {
    const result = await report({ evidenceLink: "ci://smoke/42" });
    expect(providerSmokeGateInput(result)).toEqual({
      enabled: true,
      passed: true,
      evidenceLink: "ci://smoke/42"
    });
  });

  it("rejects a report that still carries a configured credential", async () => {
    const result = await report();
    const tainted: ProviderSmokeReport = {
      ...result,
      scenarios: result.scenarios.map((scenario, index) =>
        index === 0
          ? { ...scenario, detail: { note: "test-key-primary" } }
          : scenario
      )
    };
    expect(() =>
      assertProviderSmokeReportOmitsCredentials(tainted, ["test-key-primary"])
    ).toThrow(/credential/);
    expect(() =>
      assertProviderSmokeReportOmitsCredentials(result, ["test-key-primary"])
    ).not.toThrow();
  });
});
