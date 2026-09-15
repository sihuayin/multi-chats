import { describe, expect, it } from "vitest";
import {
  runProviderSmokeMatrixAgainstProviders
} from "@/server/application/provider-smoke-runner";
import {
  redactProviderSmokeReport,
  resolveProviderSmokeConfig,
  validateProviderSmokeReport
} from "@/server/application/provider-smoke";
import {
  createProviderSmokeTestDependencies,
  createProviderSmokeTestGateway,
  resolveProviderSmokeTestConfig
} from "@/server/test-support/provider-smoke-gateway";

describe("Provider smoke matrix runner", () => {
  it("proves every contract scenario against the production services", async () => {
    const gateway = createProviderSmokeTestGateway();
    const report = await runProviderSmokeMatrixAgainstProviders(
      resolveProviderSmokeTestConfig(),
      createProviderSmokeTestDependencies(gateway)
    );

    expect(
      report.scenarios.map((scenario) => [
        scenario.scenario,
        scenario.status,
        scenario.reason
      ])
    ).toEqual([
      ["structured_output", "passed", undefined],
      ["usage_capture", "passed", undefined],
      ["context_pressure", "passed", undefined],
      ["compression", "passed", undefined],
      ["retry", "passed", undefined],
      ["failover", "passed", undefined],
      ["cancellation", "passed", undefined],
      ["brief_generation", "passed", undefined]
    ]);
    expect(report.passed).toBe(true);
    expect(report.totals.usage.source).toBe("provider");
    expect(report.totals.usage.totalTokens).toBeGreaterThan(0);
    expect(report.totals.capReached).toBe(false);
    // The seeded Pricing snapshot prices every attempt that reported usage, so
    // the cost cap bounds real spend instead of floating an inert null total.
    expect(report.totals.estimatedCostMicros).toBeGreaterThan(0);
    expect(
      report.scenarios
        .flatMap((scenario) => scenario.attempts)
        .filter((attempt) => attempt.usage.source !== "unknown")
        .every((attempt) => attempt.estimatedCostMicros !== null)
    ).toBe(true);
    expect(report.targets).toEqual([
      { role: "primary", provider: "openai", modelId: "gpt-4o-mini" },
      {
        role: "fallback",
        provider: "anthropic",
        modelId: "claude-3-5-haiku"
      }
    ]);
    expect(() => validateProviderSmokeReport(report)).not.toThrow();
    expect(() => validateProviderSmokeReport(redactProviderSmokeReport(report))).not.toThrow();
    expect(JSON.stringify(report)).not.toContain("test-key-primary");
    expect(JSON.stringify(report)).not.toContain("test-key-fallback");
  }, 60_000);

  it("records retried and failed-over Provider attempts", async () => {
    const report = await runProviderSmokeMatrixAgainstProviders(
      resolveProviderSmokeTestConfig(),
      createProviderSmokeTestDependencies(createProviderSmokeTestGateway())
    );
    const retry = report.scenarios.find(
      (scenario) => scenario.scenario === "retry"
    )!;
    expect(retry.detail.retriedSameTarget).toBe(true);
    const retryFailure = retry.attempts.find(
      (attempt) =>
        attempt.status === "failed" && attempt.errorKind === "rate_limited"
    );
    const retrySuccess = retry.attempts.find(
      (attempt) => attempt.status === "succeeded"
    );
    expect(retryFailure).toBeDefined();
    expect(retrySuccess).toBeDefined();
    // The retry must land on the primary target, not the fallback one.
    expect(retryFailure?.targetOrder).toBe(0);
    expect(retrySuccess).toMatchObject({
      targetOrder: retryFailure?.targetOrder,
      provider: retryFailure?.provider,
      modelId: retryFailure?.modelId
    });
    expect(retrySuccess!.attempt).toBeGreaterThan(retryFailure!.attempt);

    const failover = report.scenarios.find(
      (scenario) => scenario.scenario === "failover"
    )!;
    expect(failover.detail.fellOver).toBe(true);
    expect(
      failover.attempts.some(
        (attempt) =>
          attempt.provider === "anthropic" &&
          attempt.status === "succeeded" &&
          attempt.fallbackFromAttemptId
      )
    ).toBe(true);
  }, 60_000);

  it("compresses completed Rounds instead of failing under context pressure", async () => {
    const report = await runProviderSmokeMatrixAgainstProviders(
      resolveProviderSmokeTestConfig(),
      createProviderSmokeTestDependencies(createProviderSmokeTestGateway())
    );
    const compression = report.scenarios.find(
      (scenario) => scenario.scenario === "compression"
    )!;
    expect(compression.artifactLinks).toEqual([
      expect.stringMatching(/^artifact:\/\/discussion-compression\//)
    ]);
    expect(compression.detail.sourceRounds).toBeGreaterThan(0);
    expect(compression.detail.strategy).toBe("semantic");
  }, 60_000);

  it("settles a cancelled Run without leaving an active Provider attempt", async () => {
    const report = await runProviderSmokeMatrixAgainstProviders(
      resolveProviderSmokeTestConfig(),
      createProviderSmokeTestDependencies(createProviderSmokeTestGateway())
    );
    const cancellation = report.scenarios.find(
      (scenario) => scenario.scenario === "cancellation"
    )!;
    expect(cancellation.detail).toMatchObject({
      runOutcome: "cancelled",
      unsettledAttempts: 0
    });
  }, 60_000);

  it("skips failover when only one Provider credential is configured", async () => {
    const resolved = resolveProviderSmokeConfig({
      PROVIDER_SMOKE: "1",
      SMOKE_PRIMARY_PROVIDER: "openai",
      SMOKE_PRIMARY_MODEL: "gpt-4o-mini",
      SMOKE_PRIMARY_API_KEY: "test-key-primary"
    });
    if (!resolved.enabled) throw new Error("expected an enabled smoke config");
    const report = await runProviderSmokeMatrixAgainstProviders(
      resolved,
      createProviderSmokeTestDependencies(createProviderSmokeTestGateway())
    );
    expect(
      report.scenarios.find((scenario) => scenario.scenario === "failover")
    ).toMatchObject({
      status: "skipped",
      reason: "No fallback target is configured."
    });
    expect(report.passed).toBe(true);
  }, 60_000);
});
