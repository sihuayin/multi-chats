import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { evaluateDiscussionQualityReport } from "@/server/application/discussion-quality";
import { runDiscussionQualityCorpusAgainstProviders } from "@/server/application/discussion-quality-runner";
import { resolveProviderSmokeConfig } from "@/server/application/provider-smoke";
import {
  buildReleaseGateReport,
  resolveReleaseGateConfig,
  validateReleaseGateReport
} from "@/server/application/release-gate";
import { verifyProviderSmokeMatrix } from "@/server/application/provider-smoke-verification";
import { createModelGateway } from "@/server/adapters/model/model-gateway";
import { resolveModelContext } from "@/server/adapters/model/provider-registry";
import { createCredentialCipher } from "@/server/security/credential-cipher";

function loadEnvironmentFiles(): void {
  for (const path of [
    new URL("../.env", import.meta.url),
    new URL("../.env.local", import.meta.url)
  ]) {
    if (existsSync(path)) process.loadEnvFile(path);
  }
}

async function appVersions(): Promise<Record<string, string>> {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8")
  ) as {
    version: string;
    dependencies: Record<string, string>;
  };
  return {
    app: packageJson.version,
    piAi: packageJson.dependencies["@earendil-works/pi-ai"],
    piAgentCore:
      packageJson.dependencies["@earendil-works/pi-agent-core"]
  };
}

function commit(env: Record<string, string | undefined>): string {
  const configured =
    env.RELEASE_GATE_COMMIT?.trim() || env.GIT_COMMIT?.trim();
  if (configured) return configured;
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
}

function proxyConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.HTTPS_PROXY?.trim() ||
      env.HTTP_PROXY?.trim() ||
      env.SMOKE_PROXY_URL?.trim()
  );
}

async function main(): Promise<void> {
  loadEnvironmentFiles();
  const config = resolveReleaseGateConfig(process.env);
  if (!config.enabled) {
    process.stdout.write(`${config.message}\n`);
    return;
  }
  const smoke = await verifyProviderSmokeMatrix({
    env: config.providerEnvironment
  });
  if (smoke.status === "skipped" || !smoke.report) {
    throw new Error(smoke.message);
  }
  const quality = config.qualityReportPath
    ? evaluateDiscussionQualityReport(
        JSON.parse(await readFile(config.qualityReportPath, "utf8")),
        { requireReleaseRepeatCount: true }
      )
    : await (async () => {
        const providerConfig = resolveProviderSmokeConfig(
          config.providerEnvironment
        );
        if (!providerConfig.enabled) {
          throw new Error("Provider configuration is required for quality corpus.");
        }
        const qualityReport = await runDiscussionQualityCorpusAgainstProviders(
          providerConfig,
          {
            gateway: createModelGateway(),
            cipher: createCredentialCipher(),
            modelContext: ({ provider, modelId }) =>
              resolveModelContext(provider, modelId)
          }
        );
        return evaluateDiscussionQualityReport(qualityReport, {
          requireReleaseRepeatCount: true
        });
      })();
  const report = buildReleaseGateReport({
    profile: config.profile,
    smoke: smoke.report,
    quality,
    commit: commit(process.env),
    generatedAt: new Date().toISOString(),
    adapterVersions: await appVersions(),
    evidenceLink: config.evidenceLink,
    proxyConfigured: proxyConfigured(process.env)
  });
  validateReleaseGateReport(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    throw new Error(
      `Real-Provider release gate failed: ${
        report.followUpRequirements
          .map((item) => item.requirement)
          .join("; ") || "quality or coverage failed"
      }`
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
