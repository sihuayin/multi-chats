import { createModelGateway } from "@/server/adapters/model/model-gateway";
import { resolveModelContext } from "@/server/adapters/model/provider-registry";
import {
  assertProviderSmokeReportOmitsCredentials,
  providerSmokeGateInput,
  redactProviderSmokeReport,
  resolveProviderSmokeConfig,
  validateProviderSmokeReport,
  type ProviderSmokeEnvironment,
  type ProviderSmokeReport
} from "@/server/application/provider-smoke";
import {
  runProviderSmokeMatrixAgainstProviders,
  type ProviderSmokeRunnerDependencies
} from "@/server/application/provider-smoke-runner";
import { createCredentialCipher } from "@/server/security/credential-cipher";

export type ProviderSmokeVerification = {
  status: "skipped" | "passed" | "failed";
  message: string;
  report?: ProviderSmokeReport;
  gate?: ReturnType<typeof providerSmokeGateInput>;
};

function defaultDependencies(): ProviderSmokeRunnerDependencies {
  return {
    gateway: createModelGateway(),
    cipher: createCredentialCipher(),
    modelContext: ({ provider, modelId }) =>
      resolveModelContext(provider, modelId)
  };
}

/**
 * Run the opt-in Provider smoke matrix against the production adapters and
 * return its redacted evidence, so the caller owns how it is reported.
 *
 * Nothing is scheduled without an explicit `PROVIDER_SMOKE` opt-in, so the
 * default verification commands never need paid credentials or network access.
 */
export async function verifyProviderSmokeMatrix(input: {
  env: ProviderSmokeEnvironment;
  dependencies?: ProviderSmokeRunnerDependencies;
}): Promise<ProviderSmokeVerification> {
  const config = resolveProviderSmokeConfig(input.env);
  if (!config.enabled) {
    return { status: "skipped", message: config.skippedReason };
  }
  const report = await runProviderSmokeMatrixAgainstProviders(
    config,
    input.dependencies ?? defaultDependencies()
  );
  const redacted = redactProviderSmokeReport(report);
  assertProviderSmokeReportOmitsCredentials(
    redacted,
    config.targets.map((target) => target.credential)
  );
  validateProviderSmokeReport(redacted);
  return {
    status: report.passed ? "passed" : "failed",
    message: report.passed
      ? "Provider smoke matrix passed."
      : "Provider smoke matrix recorded failed scenarios.",
    report: redacted,
    gate: providerSmokeGateInput(redacted)
  };
}
