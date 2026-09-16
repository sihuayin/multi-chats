import { readFile } from "node:fs/promises";
import {
  evaluateDiscussionQualityReport,
  redactQualityEvidence,
  type DiscussionQualityReport
} from "@/server/application/discussion-quality";

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/verify-discussion-quality.ts <redacted-report.json>"
  );
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? usage();
  const report = JSON.parse(await readFile(path, "utf8")) as DiscussionQualityReport;
  const { result } = evaluateDiscussionQualityReport(report);
  process.stdout.write(`${JSON.stringify(redactQualityEvidence(result), null, 2)}\n`);
  if (!result.passed) {
    throw new Error(`Discussion quality release gate failed: ${result.gateFailures.join("; ")}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
