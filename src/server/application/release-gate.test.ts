import { describe, expect, it } from "vitest";
import {
  QUALITY_DIMENSIONS,
  DISCUSSION_QUALITY_RUBRIC_VERSION,
  type DiscussionQualityReportEvaluation
} from "@/server/application/discussion-quality";
import {
  runProviderSmokeMatrix,
  resolveProviderSmokeConfig,
  type ProviderSmokeReport,
  type ProviderSmokeScenarioExecutor
} from "@/server/application/provider-smoke";
import {
  buildReleaseGateReport,
  releaseCoverage,
  resolveReleaseGateConfig,
  validateReleaseGateReport
} from "@/server/application/release-gate";

const executor: ProviderSmokeScenarioExecutor = async ({
  scenario,
  primary,
  fallback
}) => ({
  status: "passed",
  attempts: [
    {
      provider:
        scenario === "failover" && fallback
          ? fallback.provider
          : primary.provider,
      modelId:
        scenario === "failover" && fallback
          ? fallback.modelId
          : primary.modelId,
      targetOrder: scenario === "failover" && fallback ? 1 : 0,
      attempt: 1,
      status: "succeeded",
      ...(scenario === "failover" && fallback
        ? { fallbackFromAttemptId: "primary-failed" }
        : {}),
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        source: "provider"
      },
      estimatedCostMicros: 20
    }
  ],
  artifactLinks: ["artifact://provider-smoke/artifact-1"]
});

async function smokeReport(profile: "standard" | "network_constrained") {
  const env =
    profile === "standard"
      ? {
          PROVIDER_SMOKE: "1",
          SMOKE_COVERAGE_PROFILE: "standard",
          SMOKE_PRIMARY_PROVIDER: "openai",
          SMOKE_PRIMARY_MODEL: "gpt-4o-mini",
          SMOKE_PRIMARY_API_KEY: "test-key-primary",
          SMOKE_FALLBACK_PROVIDER: "anthropic",
          SMOKE_FALLBACK_MODEL: "claude-3-5-haiku",
          SMOKE_FALLBACK_API_KEY: "test-key-fallback"
        }
      : {
          PROVIDER_SMOKE: "1",
          SMOKE_COVERAGE_PROFILE: "network_constrained",
          SMOKE_PRIMARY_PROVIDER: "deepseek",
          SMOKE_PRIMARY_MODEL: "deepseek-v4-flash",
          SMOKE_PRIMARY_API_KEY: "test-key-primary",
          SMOKE_FALLBACK_PROVIDER: "deepseek",
          SMOKE_FALLBACK_MODEL: "deepseek-v4-pro",
          SMOKE_FALLBACK_API_KEY: "test-key-fallback"
        };
  const config = resolveProviderSmokeConfig(env);
  if (!config.enabled) throw new Error("Expected enabled smoke config");
  return runProviderSmokeMatrix({
    config,
    executor,
    clock: () => "2026-01-01T00:00:00.000Z"
  });
}

function quality(
  passed = true
): DiscussionQualityReportEvaluation {
  return {
    result: {
      rubricVersion: DISCUSSION_QUALITY_RUBRIC_VERSION,
      repeatCount: 3,
      dimensions: Object.fromEntries(
        QUALITY_DIMENSIONS.map((dimension) => [
          dimension,
          { mean: passed ? 0.95 : 0.7, variance: 0, min: 0.9, max: 1 }
        ])
      ) as DiscussionQualityReportEvaluation["result"]["dimensions"],
      hardFailures: [],
      trendWarnings: [],
      passed,
      evidenceLinks: ["ci://discussion-quality/1"],
      gateFailures: passed ? [] : ["briefFidelity mean is below 0.8"]
    },
    contractVersions: {
      promptProfiles: ["discussion-prompts.v5"],
      briefSchemas: [2],
      compressionSchemas: [1],
      evidenceProtocols: ["discussion-evidence.v1"]
    }
  };
}

function report(
  profile: "standard" | "network_constrained",
  smoke: ProviderSmokeReport,
  qualityResult = quality()
) {
  return buildReleaseGateReport({
    profile,
    smoke,
    quality: qualityResult,
    commit: "abc123",
    generatedAt: "2026-01-01T00:01:00.000Z",
    adapterVersions: {
      piAi: "0.85.1",
      piAgentCore: "0.85.1"
    },
    evidenceLink: "artifact://release-gate/1",
    proxyConfigured: false
  });
}

describe("real-provider release gate", () => {
  it("skips by default without requiring credentials or a quality report", () => {
    expect(resolveReleaseGateConfig({})).toEqual({
      enabled: false,
      message:
        "Real-Provider release gate is opt-in; set PROVIDER_SMOKE=1 to run it."
    });
  });

  it("fills the network-constrained DeepSeek profile", () => {
    const config = resolveReleaseGateConfig({
      PROVIDER_SMOKE: "1",
      DEEPSEEK_API_KEY: "deepseek-key",
      SMOKE_EVIDENCE_LINK: "artifact://release-gate/network",
      SMOKE_QUALITY_REPORT_PATH: ".data/quality.json"
    });
    expect(config).toMatchObject({
      enabled: true,
      profile: "network_constrained",
      qualityReportPath: ".data/quality.json",
      providerEnvironment: {
        SMOKE_PRIMARY_PROVIDER: "deepseek",
        SMOKE_PRIMARY_MODEL: "deepseek-v4-flash",
        SMOKE_PRIMARY_API_KEY: "deepseek-key",
        SMOKE_FALLBACK_PROVIDER: "deepseek",
        SMOKE_FALLBACK_MODEL: "deepseek-v4-pro",
        SMOKE_FALLBACK_API_KEY: "deepseek-key"
      }
    });
  });

  it("requires evidence and can run quality without a prebuilt report", () => {
    expect(() =>
      resolveReleaseGateConfig({
        PROVIDER_SMOKE: "1",
        DEEPSEEK_API_KEY: "deepseek-key"
      })
    ).toThrow(/SMOKE_EVIDENCE_LINK/);
    expect(
      resolveReleaseGateConfig({
        PROVIDER_SMOKE: "1",
        DEEPSEEK_API_KEY: "deepseek-key",
        SMOKE_EVIDENCE_LINK: "artifact://release-gate/network"
      })
    ).toMatchObject({
      enabled: true,
      profile: "network_constrained"
    });
  });

  it("marks network-constrained coverage as non-equivalent and explicit", async () => {
    const smoke = await smokeReport("network_constrained");
    const gate = report("network_constrained", smoke);
    expect(gate.coverage).toMatchObject({
      crossFamilyFailoverVerified: false,
      equivalentToStandard: false,
      unverifiedFamilies: expect.arrayContaining(["anthropic", "google"])
    });
    expect(gate.passed).toBe(true);
    expect(() => validateReleaseGateReport(gate)).not.toThrow();
  });

  it("marks standard cross-family failover as equivalent", async () => {
    const smoke = await smokeReport("standard");
    expect(
      releaseCoverage("standard", smoke)
    ).toMatchObject({
      verifiedFamilies: expect.arrayContaining([
        "openai_compatible",
        "anthropic"
      ]),
      crossFamilyFailoverVerified: true,
      equivalentToStandard: true
    });
  });

  it("does not infer cross-family failover from configured targets alone", async () => {
    const smoke = await smokeReport("standard");
    smoke.scenarios = smoke.scenarios.map((scenario) =>
      scenario.scenario === "failover"
        ? {
            ...scenario,
            attempts: scenario.attempts.map((attempt) => ({
              ...attempt,
              fallbackFromAttemptId: undefined
            }))
          }
        : scenario
    );
    expect(
      releaseCoverage("standard", smoke)
    ).toMatchObject({
      crossFamilyFailoverVerified: false,
      equivalentToStandard: false
    });
  });

  it("creates focused follow-up requirements for failed quality", async () => {
    const gate = report(
      "network_constrained",
      await smokeReport("network_constrained"),
      quality(false)
    );
    expect(gate.passed).toBe(false);
    expect(gate.followUpRequirements).toContainEqual({
      kind: "quality",
      requirement:
        "Resolve Discussion-quality gate failure: briefFidelity mean is below 0.8"
    });
  });

  it("creates focused follow-ups for failed and ambiguous smoke evidence", async () => {
    const smoke = await smokeReport("network_constrained");
    smoke.passed = false;
    smoke.scenarios[0] = {
      ...smoke.scenarios[0],
      status: "failed",
      reason: "structured output did not parse"
    };
    smoke.scenarios[1] = {
      ...smoke.scenarios[1],
      attempts: [
        {
          ...smoke.scenarios[1].attempts[0],
          status: "ambiguous",
          errorKind: "unknown"
        }
      ]
    };
    const gate = report("network_constrained", smoke);
    expect(gate.followUpRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "failed_scenario" }),
        expect.objectContaining({ kind: "ambiguous_attempt" })
      ])
    );
  });

  it("rejects network coverage that claims standard equivalence", async () => {
    const gate = report(
      "network_constrained",
      await smokeReport("network_constrained")
    );
    expect(() =>
      validateReleaseGateReport({
        ...gate,
        coverage: {
          ...gate.coverage,
          crossFamilyFailoverVerified: true,
          equivalentToStandard: true
        }
      })
    ).toThrow(/cannot claim cross-family failover/);
  });
});
