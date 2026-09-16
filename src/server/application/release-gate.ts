import {
  NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS,
  PROVIDER_SMOKE_COVERAGE_PROFILES,
  PROVIDER_FAMILIES,
  REQUIRED_PROVIDER_SMOKE_FAMILIES,
  type ProviderFamily,
  type ProviderSmokeCoverageProfile,
  type ProviderSmokeEnvironment,
  type ProviderSmokeReport,
  type ProviderSmokeScenario
} from "@/server/application/provider-smoke";
import type {
  DiscussionQualityGateResult,
  DiscussionQualityReportEvaluation
} from "@/server/application/discussion-quality";

export const RELEASE_GATE_VERSION = "release-gate.v1";
export type ReleaseGateProfile = ProviderSmokeCoverageProfile;
export type ReleaseGateEnvironment = Record<string, string | undefined>;

export type ReleaseGateConfig =
  | { enabled: false; message: string }
  | {
      enabled: true;
      profile: ReleaseGateProfile;
      providerEnvironment: ProviderSmokeEnvironment;
      qualityReportPath: string;
      evidenceLink: string;
    };

export type ReleaseCoverage = {
  profile: ReleaseGateProfile;
  verifiedFamilies: ProviderFamily[];
  unverifiedFamilies: ProviderFamily[];
  crossFamilyFailoverVerified: boolean;
  equivalentToStandard: boolean;
  limitations: string[];
};

export type ReleaseGateFollowUp = {
  kind: "failed_scenario" | "incomplete_scenario" | "ambiguous_attempt" | "quality";
  scenario?: ProviderSmokeScenario;
  requirement: string;
};

export type ReleaseGateReport = {
  gateVersion: typeof RELEASE_GATE_VERSION;
  passed: boolean;
  generatedAt: string;
  commit: string;
  coverage: ReleaseCoverage;
  adapterVersions: Record<string, string>;
  contractVersions: {
    smokeMatrix: string;
    discussionRubric: string;
    promptProfiles: string[];
    briefSchemas: number[];
    compressionSchemas: number[];
    evidenceProtocols: string[];
  };
  proxyConfigured: boolean;
  redaction: "redacted";
  evidenceLink: string;
  limits: ProviderSmokeReport["limits"];
  smoke: ProviderSmokeReport;
  quality: DiscussionQualityGateResult;
  followUpRequirements: ReleaseGateFollowUp[];
};

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function profile(value: string | undefined): ReleaseGateProfile {
  const selected = value?.trim() || "network_constrained";
  if (
    PROVIDER_SMOKE_COVERAGE_PROFILES.includes(
      selected as ReleaseGateProfile
    )
  ) {
    return selected as ReleaseGateProfile;
  }
  throw new Error(
    "RELEASE_GATE_PROFILE must be standard or network_constrained"
  );
}

export function resolveReleaseGateConfig(
  env: ReleaseGateEnvironment
): ReleaseGateConfig {
  const selected = profile(env.RELEASE_GATE_PROFILE);
  if (!truthy(env.PROVIDER_SMOKE)) {
    return {
      enabled: false,
      message:
        "Real-Provider release gate is opt-in; set PROVIDER_SMOKE=1 to run it."
    };
  }
  const evidenceLink = env.SMOKE_EVIDENCE_LINK?.trim();
  if (!evidenceLink) {
    throw new Error("SMOKE_EVIDENCE_LINK is required for release evidence.");
  }
  const qualityReportPath = env.SMOKE_QUALITY_REPORT_PATH?.trim();
  if (!qualityReportPath) {
    throw new Error(
      "SMOKE_QUALITY_REPORT_PATH is required to evaluate the Discussion-quality gate."
    );
  }
  if (selected === "standard") {
    return {
      enabled: true,
      profile: selected,
      providerEnvironment: {
        ...env,
        SMOKE_COVERAGE_PROFILE: "standard",
        SMOKE_EVIDENCE_LINK: evidenceLink
      },
      qualityReportPath,
      evidenceLink
    };
  }

  const sharedCredential =
    env.SMOKE_PRIMARY_API_KEY?.trim() || env.DEEPSEEK_API_KEY?.trim();
  return {
    enabled: true,
    profile: selected,
    providerEnvironment: {
      ...env,
      SMOKE_COVERAGE_PROFILE: "network_constrained",
      SMOKE_PRIMARY_PROVIDER:
        env.SMOKE_PRIMARY_PROVIDER?.trim() ||
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.primary.provider,
      SMOKE_PRIMARY_MODEL:
        env.SMOKE_PRIMARY_MODEL?.trim() ||
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.primary.modelId,
      ...(sharedCredential
        ? { SMOKE_PRIMARY_API_KEY: sharedCredential }
        : {}),
      SMOKE_FALLBACK_PROVIDER:
        env.SMOKE_FALLBACK_PROVIDER?.trim() ||
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.fallback.provider,
      SMOKE_FALLBACK_MODEL:
        env.SMOKE_FALLBACK_MODEL?.trim() ||
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.fallback.modelId,
      ...(sharedCredential
        ? {
            SMOKE_FALLBACK_API_KEY:
              env.SMOKE_FALLBACK_API_KEY?.trim() || sharedCredential
          }
        : env.SMOKE_FALLBACK_API_KEY
          ? { SMOKE_FALLBACK_API_KEY: env.SMOKE_FALLBACK_API_KEY.trim() }
          : {}),
      SMOKE_EVIDENCE_LINK: evidenceLink
    },
    qualityReportPath,
    evidenceLink
  };
}

export function releaseCoverage(
  selected: ReleaseGateProfile,
  report: ProviderSmokeReport
): ReleaseCoverage {
  const allFamilies = [...new Set(Object.values(PROVIDER_FAMILIES))];
  const verified = new Set(
    report.targets.map((target) => PROVIDER_FAMILIES[target.provider])
  );
  const verifiedFamilies = allFamilies.filter((family) => verified.has(family));
  const unverifiedFamilies = allFamilies.filter(
    (family) => !verified.has(family)
  );
  const primaryFamily = report.targets[0]
    ? PROVIDER_FAMILIES[report.targets[0].provider]
    : undefined;
  const failoverScenario = report.scenarios.find(
    (scenario) => scenario.scenario === "failover"
  );
  const crossFamilyFailoverVerified =
    selected === "standard" &&
    report.targets.length > 1 &&
    REQUIRED_PROVIDER_SMOKE_FAMILIES.every((family) =>
      verified.has(family)
    ) &&
    Boolean(
      failoverScenario?.attempts.some(
        (attempt) =>
          attempt.status === "succeeded" &&
          Boolean(attempt.fallbackFromAttemptId) &&
          PROVIDER_FAMILIES[attempt.provider] !== primaryFamily
      )
    );
  const equivalentToStandard =
    selected === "standard" && crossFamilyFailoverVerified;
  return {
    profile: selected,
    verifiedFamilies,
    unverifiedFamilies,
    crossFamilyFailoverVerified,
    equivalentToStandard,
    limitations:
      selected === "network_constrained"
        ? [
            "Network-constrained coverage proves switching between DeepSeek targets, not cross-family failover.",
            `Unverified Provider families: ${unverifiedFamilies.join(", ")}.`
          ]
        : unverifiedFamilies.length > 0
          ? [
              `Optional Provider families not verified by this run: ${unverifiedFamilies.join(", ")}.`
            ]
          : []
  };
}

export function buildReleaseGateReport(input: {
  profile: ReleaseGateProfile;
  smoke: ProviderSmokeReport;
  quality: DiscussionQualityReportEvaluation;
  commit: string;
  generatedAt: string;
  adapterVersions: Record<string, string>;
  evidenceLink: string;
  proxyConfigured: boolean;
}): ReleaseGateReport {
  const coverage = releaseCoverage(input.profile, input.smoke);
  const followUpRequirements: ReleaseGateFollowUp[] = [];
  for (const scenario of input.smoke.scenarios) {
    if (scenario.status === "failed") {
      followUpRequirements.push({
        kind: "failed_scenario",
        scenario: scenario.scenario,
        requirement: `Investigate and fix ${scenario.scenario}: ${
          scenario.reason ?? "scenario failed"
        }`
      });
    } else if (scenario.status === "skipped") {
      followUpRequirements.push({
        kind: "incomplete_scenario",
        scenario: scenario.scenario,
        requirement: `Complete release coverage for ${scenario.scenario}: ${
          scenario.reason ?? "scenario was skipped"
        }`
      });
    }
    for (const attempt of scenario.attempts) {
      if (attempt.status === "ambiguous") {
        followUpRequirements.push({
          kind: "ambiguous_attempt",
          scenario: scenario.scenario,
          requirement: `Resolve the ambiguous ${attempt.provider}/${attempt.modelId} attempt in ${scenario.scenario} without replaying side effects.`
        });
      }
    }
  }
  for (const failure of input.quality.result.gateFailures) {
    followUpRequirements.push({
      kind: "quality",
      requirement: `Resolve Discussion-quality gate failure: ${failure}`
    });
  }
  const profilePassed =
    input.profile === "standard"
      ? coverage.crossFamilyFailoverVerified
      : !coverage.crossFamilyFailoverVerified &&
        coverage.unverifiedFamilies.includes("anthropic") &&
        coverage.unverifiedFamilies.includes("google");
  return {
    gateVersion: RELEASE_GATE_VERSION,
    passed:
      input.smoke.passed &&
      input.quality.result.passed &&
      profilePassed &&
      followUpRequirements.length === 0 &&
      input.commit.trim().length > 0,
    generatedAt: input.generatedAt,
    commit: input.commit,
    coverage,
    adapterVersions: input.adapterVersions,
    contractVersions: {
      smokeMatrix: input.smoke.matrixVersion,
      discussionRubric: input.quality.result.rubricVersion,
      promptProfiles: input.quality.contractVersions.promptProfiles,
      briefSchemas: input.quality.contractVersions.briefSchemas,
      compressionSchemas: input.quality.contractVersions.compressionSchemas,
      evidenceProtocols: input.quality.contractVersions.evidenceProtocols
    },
    proxyConfigured: input.proxyConfigured,
    redaction: "redacted",
    evidenceLink: input.evidenceLink,
    limits: input.smoke.limits,
    smoke: input.smoke,
    quality: input.quality.result,
    followUpRequirements
  };
}

const SENSITIVE = /(bearer\s+\S+|sk-[a-z0-9_-]{8,}|api[_-]?key)/i;

export function validateReleaseGateReport(report: ReleaseGateReport): void {
  if (report.gateVersion !== RELEASE_GATE_VERSION) {
    throw new Error("Release gate report uses an unsupported version.");
  }
  if (report.redaction !== "redacted") {
    throw new Error("Release gate report must declare redacted evidence.");
  }
  if (report.smoke.coverageProfile !== report.coverage.profile) {
    throw new Error(
      "Release gate coverage profile disagrees with the smoke report."
    );
  }
  if (report.coverage.profile === "network_constrained") {
    if (
      report.smoke.targets.length !== 2 ||
      report.smoke.targets[0]?.provider !==
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.primary.provider ||
      report.smoke.targets[0]?.modelId !==
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.primary.modelId ||
      report.smoke.targets[1]?.role !== "fallback" ||
      report.smoke.targets[1]?.provider !==
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.fallback.provider ||
      report.smoke.targets[1]?.modelId !==
        NETWORK_CONSTRAINED_PROVIDER_SMOKE_TARGETS.fallback.modelId
    ) {
      throw new Error(
        "Network-constrained coverage must use the approved DeepSeek targets."
      );
    }
    if (report.coverage.crossFamilyFailoverVerified) {
      throw new Error(
        "Network-constrained coverage cannot claim cross-family failover."
      );
    }
    if (report.coverage.equivalentToStandard) {
      throw new Error(
        "Network-constrained coverage cannot be equivalent to the standard profile."
      );
    }
    if (
      !report.coverage.unverifiedFamilies.includes("anthropic") ||
      !report.coverage.unverifiedFamilies.includes("google")
    ) {
      throw new Error(
        "Network-constrained coverage must list every unverified family."
      );
    }
  }
  if (
    report.coverage.equivalentToStandard &&
    !report.coverage.crossFamilyFailoverVerified
  ) {
    throw new Error(
      "Release coverage cannot be equivalent to standard without cross-family failover."
    );
  }
  if (!report.commit.trim()) {
    throw new Error("Release gate report must identify a commit.");
  }
  if (SENSITIVE.test(JSON.stringify(report))) {
    throw new Error("Release gate report contains credential-shaped data.");
  }
}
