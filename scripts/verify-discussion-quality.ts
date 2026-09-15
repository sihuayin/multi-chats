import { readFile } from "node:fs/promises";
import {
  DISCUSSION_QUALITY_CORPUS,
  evaluateQualityGate,
  redactQualityEvidence,
  validateQualityResults,
  type DiscussionQualityGateInput,
  type DiscussionQualityResult
} from "@/server/application/discussion-quality";

type QualityReport = {
  deterministicRuns: DiscussionQualityResult[][];
  evidenceLinks?: string[];
  realProvider?: DiscussionQualityGateInput["realProvider"];
};

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/verify-discussion-quality.ts <redacted-report.json>"
  );
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? usage();
  const report = JSON.parse(await readFile(path, "utf8")) as QualityReport;
  if (!Array.isArray(report.deterministicRuns) || report.deterministicRuns.length === 0) {
    throw new Error("Quality report must contain at least one deterministic run.");
  }
  const expectedScenarios = new Set(DISCUSSION_QUALITY_CORPUS.map((item) => item.id));
  const deterministicResults = report.deterministicRuns.flat();
  validateQualityResults(deterministicResults);
  const scenarioIds = new Set(deterministicResults.map((result) => result.scenarioId));
  for (const scenarioId of expectedScenarios) {
    if (!scenarioIds.has(scenarioId)) {
      throw new Error(`Quality report is missing corpus scenario ${scenarioId}.`);
    }
  }

  const result = evaluateQualityGate(report);
  process.stdout.write(`${JSON.stringify(redactQualityEvidence(result), null, 2)}\n`);
  if (!result.passed) {
    throw new Error(`Discussion quality release gate failed: ${result.gateFailures.join("; ")}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
