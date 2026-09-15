import type {
  IsoDate,
  ModelUsage,
  ProviderAttemptStatus,
  ProviderFailureKind,
  ProviderId
} from "@/server/domain/types";
import type { DiscussionQualityGateInput } from "@/server/application/discussion-quality";

export const PROVIDER_SMOKE_MATRIX_VERSION = "provider-smoke.v1";

export const PROVIDER_SMOKE_SCENARIOS = [
  "structured_output",
  "usage_capture",
  "context_pressure",
  "compression",
  "retry",
  "failover",
  "cancellation",
  "brief_generation"
] as const;

export type ProviderSmokeScenario = (typeof PROVIDER_SMOKE_SCENARIOS)[number];

export type ProviderSmokeScenarioSpec = {
  scenario: ProviderSmokeScenario;
  /** The scenario needs a configured fallback target to mean anything. */
  requiresFallbackTarget: boolean;
  /** The scenario only counts as passed with a linked artifact. */
  requiresArtifactLink: boolean;
};

/**
 * Every Smoke scenario's contract, keyed by scenario so adding a scenario
 * without declaring its contract cannot compile.
 */
const PROVIDER_SMOKE_SCENARIO_CONTRACTS: Record<
  ProviderSmokeScenario,
  Omit<ProviderSmokeScenarioSpec, "scenario">
> = {
  structured_output: {
    requiresFallbackTarget: false,
    requiresArtifactLink: false
  },
  usage_capture: {
    requiresFallbackTarget: false,
    requiresArtifactLink: false
  },
  context_pressure: {
    requiresFallbackTarget: false,
    requiresArtifactLink: false
  },
  compression: {
    requiresFallbackTarget: false,
    requiresArtifactLink: true
  },
  retry: {
    requiresFallbackTarget: false,
    requiresArtifactLink: false
  },
  failover: {
    requiresFallbackTarget: true,
    requiresArtifactLink: false
  },
  cancellation: {
    requiresFallbackTarget: false,
    requiresArtifactLink: false
  },
  brief_generation: {
    requiresFallbackTarget: false,
    requiresArtifactLink: true
  }
};

/** The contract every Smoke scenario must satisfy, in execution order. */
export const PROVIDER_SMOKE_SCENARIO_SPECS: readonly ProviderSmokeScenarioSpec[] =
  PROVIDER_SMOKE_SCENARIOS.map((scenario) => ({
    scenario,
    ...PROVIDER_SMOKE_SCENARIO_CONTRACTS[scenario]
  }));

export type ProviderFamily = "openai_compatible" | "anthropic" | "google";

export const PROVIDER_FAMILIES: Record<ProviderId, ProviderFamily> = {
  openai: "openai_compatible",
  openrouter: "openai_compatible",
  deepseek: "openai_compatible",
  groq: "openai_compatible",
  mistral: "openai_compatible",
  anthropic: "anthropic",
  google: "google"
};

/** Families a multi-target Provider smoke matrix must cover. */
export const REQUIRED_PROVIDER_SMOKE_FAMILIES: readonly ProviderFamily[] = [
  "openai_compatible",
  "anthropic"
];

export const DEFAULT_PROVIDER_SMOKE_LIMITS: ProviderSmokeLimits = {
  maxTotalTokens: 20_000,
  maxCostMicros: 500_000,
  timeoutMs: 30_000
};

export type ProviderSmokeLimits = {
  maxTotalTokens: number;
  maxCostMicros: number;
  timeoutMs: number;
};

export type ProviderSmokePricing = {
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
};

/**
 * Conservative fixture rates used only to stamp cost into the smoke
 * Workspace, where no operator pricing table exists. Set the two
 * `SMOKE_*_MICROS_PER_MILLION_TOKENS` variables to the Provider's real rates to
 * make the cost cap bound real spend.
 */
export const DEFAULT_PROVIDER_SMOKE_PRICING: ProviderSmokePricing = {
  inputMicrosPerMillionTokens: 3_000_000,
  outputMicrosPerMillionTokens: 15_000_000
};

export type ProviderSmokeTarget = {
  role: "primary" | "fallback";
  provider: ProviderId;
  modelId: string;
  credential: string;
};

export type ProviderSmokeRunConfig = {
  enabled: true;
  targets: [ProviderSmokeTarget, ...ProviderSmokeTarget[]];
  limits: ProviderSmokeLimits;
  pricing: ProviderSmokePricing;
  evidenceLink?: string;
};

export type ProviderSmokeConfig =
  | { enabled: false; skippedReason: string }
  | ProviderSmokeRunConfig;

export type ProviderSmokeEnvironment = Record<string, string | undefined>;

export class ProviderSmokeConfigError extends Error {
  readonly code = "provider_smoke_invalid_config";

  constructor(message: string) {
    super(message);
    this.name = "ProviderSmokeConfigError";
  }
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  key: string,
  unit: string
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ProviderSmokeConfigError(
      `${key} must be a positive integer number of ${unit}`
    );
  }
  return parsed;
}

function resolveTarget(
  env: ProviderSmokeEnvironment,
  role: "primary" | "fallback"
): ProviderSmokeTarget | undefined {
  const prefix = role === "primary" ? "SMOKE_PRIMARY" : "SMOKE_FALLBACK";
  const provider = env[`${prefix}_PROVIDER`]?.trim();
  const modelId = env[`${prefix}_MODEL`]?.trim();
  const credential = env[`${prefix}_API_KEY`]?.trim();
  const provided = [provider, modelId, credential].filter(
    (value) => value !== undefined && value !== ""
  );
  if (provided.length === 0) return undefined;
  if (!provider || !modelId || !credential) {
    throw new ProviderSmokeConfigError(
      `${prefix}_PROVIDER, ${prefix}_MODEL, and ${prefix}_API_KEY must all be set to run the Provider smoke matrix`
    );
  }
  if (!(provider in PROVIDER_FAMILIES)) {
    throw new ProviderSmokeConfigError(
      `${prefix}_PROVIDER must be a known Provider`
    );
  }
  return {
    role,
    provider: provider as ProviderId,
    modelId,
    credential
  };
}

/**
 * Resolve the opt-in Provider smoke matrix from the environment. Nothing
 * runs without an explicit opt-in, so the default test command never needs
 * paid credentials or network access.
 */
export function resolveProviderSmokeConfig(
  env: ProviderSmokeEnvironment
): ProviderSmokeConfig {
  if (!truthy(env.PROVIDER_SMOKE)) {
    return {
      enabled: false,
      skippedReason:
        "Provider smoke matrix is opt-in; set PROVIDER_SMOKE=1 with target credentials to run it."
    };
  }
  const primary = resolveTarget(env, "primary");
  const fallback = resolveTarget(env, "fallback");
  if (!primary) {
    throw new ProviderSmokeConfigError(
      "SMOKE_PRIMARY_PROVIDER, SMOKE_PRIMARY_MODEL, and SMOKE_PRIMARY_API_KEY are required when PROVIDER_SMOKE is set"
    );
  }
  const targets = [primary, ...(fallback ? [fallback] : [])] as [
    ProviderSmokeTarget,
    ...ProviderSmokeTarget[]
  ];
  // A single configured credential still proves the contracts, but any run
  // that configures more than one target must cover every required family, so
  // one Provider outage cannot hide a broken adapter behind another.
  if (targets.length > 1) {
    const families = new Set(
      targets.map((target) => PROVIDER_FAMILIES[target.provider])
    );
    const missingFamilies = REQUIRED_PROVIDER_SMOKE_FAMILIES.filter(
      (family) => !families.has(family)
    );
    if (missingFamilies.length > 0) {
      throw new ProviderSmokeConfigError(
        `Provider smoke matrix must cover ${missingFamilies.join(
          ", "
        )}; configure at least one target per required family`
      );
    }
  }
  const evidenceLink = env.SMOKE_EVIDENCE_LINK?.trim();
  return {
    enabled: true,
    targets,
    limits: {
      maxTotalTokens: positiveInteger(
        env.SMOKE_MAX_TOTAL_TOKENS,
        DEFAULT_PROVIDER_SMOKE_LIMITS.maxTotalTokens,
        "SMOKE_MAX_TOTAL_TOKENS",
        "tokens"
      ),
      maxCostMicros: positiveInteger(
        env.SMOKE_MAX_COST_MICROS,
        DEFAULT_PROVIDER_SMOKE_LIMITS.maxCostMicros,
        "SMOKE_MAX_COST_MICROS",
        "micros"
      ),
      timeoutMs: positiveInteger(
        env.SMOKE_PROVIDER_TIMEOUT_MS,
        DEFAULT_PROVIDER_SMOKE_LIMITS.timeoutMs,
        "SMOKE_PROVIDER_TIMEOUT_MS",
        "milliseconds"
      )
    },
    pricing: {
      inputMicrosPerMillionTokens: positiveInteger(
        env.SMOKE_INPUT_MICROS_PER_MILLION_TOKENS,
        DEFAULT_PROVIDER_SMOKE_PRICING.inputMicrosPerMillionTokens,
        "SMOKE_INPUT_MICROS_PER_MILLION_TOKENS",
        "micros per million tokens"
      ),
      outputMicrosPerMillionTokens: positiveInteger(
        env.SMOKE_OUTPUT_MICROS_PER_MILLION_TOKENS,
        DEFAULT_PROVIDER_SMOKE_PRICING.outputMicrosPerMillionTokens,
        "SMOKE_OUTPUT_MICROS_PER_MILLION_TOKENS",
        "micros per million tokens"
      )
    },
    ...(evidenceLink ? { evidenceLink } : {})
  };
}

export type ProviderSmokeAttemptRecord = {
  provider: ProviderId;
  modelId: string;
  targetOrder: number;
  attempt: number;
  status: ProviderAttemptStatus;
  errorKind?: ProviderFailureKind;
  errorCode?: string;
  fallbackFromAttemptId?: string;
  usage: ModelUsage;
  estimatedCostMicros: number | null;
};

export type ProviderSmokeScenarioResult = {
  scenario: ProviderSmokeScenario;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  attempts: ProviderSmokeAttemptRecord[];
  usage: ModelUsage;
  estimatedCostMicros: number | null;
  artifactLinks: string[];
  detail: Record<string, string | number | boolean>;
};

export type ProviderSmokeReport = {
  matrixVersion: typeof PROVIDER_SMOKE_MATRIX_VERSION;
  enabled: true;
  startedAt: IsoDate;
  completedAt: IsoDate;
  targets: Array<{
    role: "primary" | "fallback";
    provider: ProviderId;
    modelId: string;
  }>;
  limits: ProviderSmokeLimits;
  totals: {
    attempts: number;
    usage: ModelUsage;
    estimatedCostMicros: number | null;
    capReached: boolean;
  };
  scenarios: ProviderSmokeScenarioResult[];
  evidenceLink?: string;
  passed: boolean;
};

export type ProviderSmokeScenarioOutcome = {
  status: "passed" | "failed";
  reason?: string;
  attempts: ProviderSmokeAttemptRecord[];
  artifactLinks?: string[];
  detail?: Record<string, string | number | boolean>;
};

export type ProviderSmokeScenarioContext = {
  scenario: ProviderSmokeScenario;
  config: ProviderSmokeRunConfig;
  primary: ProviderSmokeTarget;
  fallback?: ProviderSmokeTarget;
};

export type ProviderSmokeScenarioExecutor = (
  context: ProviderSmokeScenarioContext
) => Promise<ProviderSmokeScenarioOutcome>;

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "reasoningTokens",
  "totalTokens"
] as const;

export function sumModelUsage(usages: readonly ModelUsage[]): ModelUsage {
  const total: ModelUsage = { source: "unknown" };
  for (const usage of usages) {
    for (const field of USAGE_FIELDS) {
      const value = usage[field];
      if (value === undefined) continue;
      total[field] = (total[field] ?? 0) + value;
    }
    if (usage.source === "provider") {
      total.source = "provider";
    } else if (usage.source === "estimated" && total.source !== "provider") {
      total.source = "estimated";
    }
  }
  return total;
}

function sumCosts(costs: readonly (number | null)[]): number | null {
  return costs.some((cost) => cost !== null)
    ? costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
    : null;
}

function capReached(
  usage: ModelUsage,
  costMicros: number | null,
  limits: ProviderSmokeLimits
): boolean {
  if ((usage.totalTokens ?? 0) >= limits.maxTotalTokens) return true;
  return costMicros !== null && costMicros >= limits.maxCostMicros;
}

function scenarioResult(
  scenario: ProviderSmokeScenario,
  outcome: ProviderSmokeScenarioOutcome
): ProviderSmokeScenarioResult {
  const usages = outcome.attempts.map((attempt) => attempt.usage);
  return {
    scenario,
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    attempts: outcome.attempts,
    usage: sumModelUsage(usages),
    estimatedCostMicros: sumCosts(
      outcome.attempts.map((attempt) => attempt.estimatedCostMicros)
    ),
    artifactLinks: outcome.artifactLinks ?? [],
    detail: outcome.detail ?? {}
  };
}

function skippedScenario(
  scenario: ProviderSmokeScenario,
  reason: string
): ProviderSmokeScenarioResult {
  return {
    scenario,
    status: "skipped",
    reason,
    attempts: [],
    usage: { source: "unknown" },
    estimatedCostMicros: null,
    artifactLinks: [],
    detail: {}
  };
}

const NO_FALLBACK_SKIP_REASON = "No fallback target is configured.";
const CAP_REACHED_SKIP_REASON = "Provider smoke token or cost cap reached.";

/**
 * Run the matrix in order, stopping the remaining scenarios once a token or
 * cost cap is reached so a paid run can never drift past its budget.
 */
export async function runProviderSmokeMatrix(input: {
  config: ProviderSmokeRunConfig;
  executor: ProviderSmokeScenarioExecutor;
  clock: () => IsoDate;
}): Promise<ProviderSmokeReport> {
  const { config, executor } = input;
  const startedAt = input.clock();
  const primary = config.targets[0];
  const fallback = config.targets.find((target) => target.role === "fallback");
  const scenarios: ProviderSmokeScenarioResult[] = [];
  let capped = false;

  for (const spec of PROVIDER_SMOKE_SCENARIO_SPECS) {
    const attemptsSoFar = scenarios.flatMap((scenario) => scenario.attempts);
    const spendSoFar = {
      usage: sumModelUsage(attemptsSoFar.map((attempt) => attempt.usage)),
      estimatedCostMicros: sumCosts(
        attemptsSoFar.map((attempt) => attempt.estimatedCostMicros)
      )
    };
    if (
      spec.requiresFallbackTarget &&
      !config.targets.some((target) => target.role === "fallback")
    ) {
      scenarios.push(
        skippedScenario(spec.scenario, NO_FALLBACK_SKIP_REASON)
      );
      continue;
    }
    if (capReached(spendSoFar.usage, spendSoFar.estimatedCostMicros, config.limits)) {
      capped = true;
      scenarios.push(skippedScenario(spec.scenario, CAP_REACHED_SKIP_REASON));
      continue;
    }
    const outcome = await executor({
      scenario: spec.scenario,
      config,
      primary,
      ...(fallback ? { fallback } : {})
    });
    scenarios.push(scenarioResult(spec.scenario, outcome));
  }

  const attempts = scenarios.flatMap((scenario) => scenario.attempts);
  const totals = {
    attempts: attempts.length,
    usage: sumModelUsage(attempts.map((attempt) => attempt.usage)),
    estimatedCostMicros: sumCosts(
      attempts.map((attempt) => attempt.estimatedCostMicros)
    ),
    capReached: capped
  };
  return {
    matrixVersion: PROVIDER_SMOKE_MATRIX_VERSION,
    enabled: true,
    startedAt,
    completedAt: input.clock(),
    targets: config.targets.map((target) => ({
      role: target.role,
      provider: target.provider,
      modelId: target.modelId
    })),
    limits: config.limits,
    totals,
    scenarios,
    ...(config.evidenceLink ? { evidenceLink: config.evidenceLink } : {}),
    passed:
      !capped &&
      scenarios.every((scenario) => scenario.status !== "failed") &&
      scenarios.some((scenario) => scenario.status === "passed")
  };
}

const EVIDENCE_LINK = /^(?:https?:\/\/|ci:\/\/|artifact:\/\/)/;
const SENSITIVE_VALUE_PATTERN = "(?:sk-[A-Za-z0-9_-]{8,}|Bearer\\s+\\S+)";
const SENSITIVE_VALUE = new RegExp(SENSITIVE_VALUE_PATTERN);
const SENSITIVE_VALUE_GLOBAL = new RegExp(SENSITIVE_VALUE_PATTERN, "g");

function assertUsage(value: ModelUsage, scenario: ProviderSmokeScenario): void {
  for (const field of USAGE_FIELDS) {
    const count = value[field];
    if (count === undefined) continue;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(
        `Provider smoke scenario ${scenario} records an invalid ${field}`
      );
    }
  }
}

/**
 * Prove a smoke report is complete, within caps, and secret-free before it
 * is used as release evidence.
 */
export function validateProviderSmokeReport(report: ProviderSmokeReport): void {
  if (report.matrixVersion !== PROVIDER_SMOKE_MATRIX_VERSION) {
    throw new Error("Provider smoke report uses an unsupported matrix version");
  }
  const byScenario = new Map(
    report.scenarios.map((scenario) => [scenario.scenario, scenario])
  );
  if (byScenario.size !== report.scenarios.length) {
    throw new Error("Provider smoke report repeats a scenario");
  }
  for (const spec of PROVIDER_SMOKE_SCENARIO_SPECS) {
    const result = byScenario.get(spec.scenario);
    if (!result) {
      throw new Error(
        `Provider smoke report is missing scenario ${spec.scenario}`
      );
    }
    if (result.status === "skipped") {
      const allowed =
        (spec.requiresFallbackTarget &&
          result.reason === NO_FALLBACK_SKIP_REASON) ||
        report.totals.capReached;
      if (!allowed) {
        throw new Error(
          `Provider smoke scenario ${spec.scenario} was skipped without a reason the matrix allows`
        );
      }
      continue;
    }
    if (result.attempts.length === 0) {
      throw new Error(
        `Provider smoke scenario ${spec.scenario} recorded no Provider attempt`
      );
    }
    for (const attempt of result.attempts) {
      if (!attempt.provider || !attempt.modelId) {
        throw new Error(
          `Provider smoke scenario ${spec.scenario} records an attempt without a Provider and model`
        );
      }
      assertUsage(attempt.usage, spec.scenario);
      if (
        attempt.estimatedCostMicros !== null &&
        (!Number.isInteger(attempt.estimatedCostMicros) ||
          attempt.estimatedCostMicros < 0)
      ) {
        throw new Error(
          `Provider smoke scenario ${spec.scenario} records an invalid cost`
        );
      }
    }
    assertUsage(result.usage, spec.scenario);
    if (spec.requiresArtifactLink && result.artifactLinks.length === 0) {
      throw new Error(
        `Provider smoke scenario ${spec.scenario} requires an artifact link`
      );
    }
  }
  for (const scenario of report.scenarios) {
    for (const link of scenario.artifactLinks) {
      if (!EVIDENCE_LINK.test(link)) {
        throw new Error(
          `Provider smoke scenario ${scenario.scenario} records an invalid artifact link`
        );
      }
    }
  }
  if (report.evidenceLink && !EVIDENCE_LINK.test(report.evidenceLink)) {
    throw new Error("Provider smoke report records an invalid evidence link");
  }
  assertUsage(report.totals.usage, "usage_capture");
  // The matrix stops scheduling scenarios once a cap is reached, but the
  // scenario that crossed it has already spent its tokens, so an overshoot
  // is only tolerable on a capped report that cannot pass.
  if (
    !report.totals.capReached &&
    report.totals.usage.totalTokens !== undefined &&
    report.totals.usage.totalTokens > report.limits.maxTotalTokens
  ) {
    throw new Error("Provider smoke matrix exceeded its token cap");
  }
  if (
    !report.totals.capReached &&
    report.totals.estimatedCostMicros !== null &&
    report.totals.estimatedCostMicros > report.limits.maxCostMicros
  ) {
    throw new Error("Provider smoke matrix exceeded its cost cap");
  }
  const passed =
    !report.totals.capReached &&
    report.scenarios.every((scenario) => scenario.status !== "failed") &&
    report.scenarios.some((scenario) => scenario.status === "passed");
  if (report.passed !== passed) {
    throw new Error("Provider smoke report pass flag disagrees with its results");
  }
  if (SENSITIVE_VALUE.test(JSON.stringify(report))) {
    throw new Error("Provider smoke report contains a secret");
  }
}

const SENSITIVE_KEY = /(credential|secret|api[_-]?key|authorization|bearer)/i;

/** Strip anything secret-shaped before a smoke report leaves the process. */
export function redactProviderSmokeReport(
  report: ProviderSmokeReport
): ProviderSmokeReport {
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") {
      return typeof value === "string"
        ? value.replace(SENSITIVE_VALUE_GLOBAL, "[REDACTED]")
        : value;
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item);
    }
    return output;
  };
  return redact(report) as ProviderSmokeReport;
}

/** Shape the report as opt-in evidence for the Discussion release gate. */
export function providerSmokeGateInput(
  report: ProviderSmokeReport
): NonNullable<DiscussionQualityGateInput["realProvider"]> {
  return {
    enabled: true,
    passed: report.passed,
    ...(report.evidenceLink ? { evidenceLink: report.evidenceLink } : {})
  };
}

/**
 * Prove a report never carries the live credentials it was run with: the
 * shape-based redaction cannot know a bare key it was configured with.
 */
export function assertProviderSmokeReportOmitsCredentials(
  report: ProviderSmokeReport,
  credentials: readonly string[]
): void {
  const serialized = JSON.stringify(report);
  for (const credential of credentials) {
    if (serialized.includes(credential)) {
      throw new Error("Provider smoke report contains a Provider credential");
    }
  }
}
