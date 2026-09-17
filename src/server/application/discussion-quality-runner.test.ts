import { describe, expect, it } from "vitest";
import {
  DISCUSSION_QUALITY_CORPUS,
  DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT,
  evaluateDiscussionQualityReport
} from "@/server/application/discussion-quality";
import { runDiscussionQualityCorpusAgainstProviders } from "@/server/application/discussion-quality-runner";
import {
  createProviderSmokeTestDependencies,
  createProviderSmokeTestGateway,
  resolveProviderSmokeTestConfig
} from "@/server/test-support/provider-smoke-gateway";

describe("Discussion quality corpus runner", () => {
  it("runs every corpus mode three times against the configured adapter", async () => {
    const gateway = createProviderSmokeTestGateway();
    const report = await runDiscussionQualityCorpusAgainstProviders(
      resolveProviderSmokeTestConfig({
        SMOKE_MAX_TOTAL_TOKENS: "1000000",
        SMOKE_MAX_COST_MICROS: "6000000"
      }),
      createProviderSmokeTestDependencies(gateway)
    );
    const evaluation = evaluateDiscussionQualityReport(report, {
      requireReleaseRepeatCount: true
    });

    expect(report.deterministicRuns).toHaveLength(
      DISCUSSION_QUALITY_RELEASE_REPEAT_COUNT
    );
    for (const run of report.deterministicRuns) {
      expect(run.map((result) => result.scenarioId)).toEqual(
        DISCUSSION_QUALITY_CORPUS.map((scenario) => scenario.id)
      );
    }
    expect(evaluation.contractVersions.promptProfiles).toEqual([
      "discussion-prompts.v3"
    ]);
    expect(report.evidenceLinks).toEqual(["ci://provider-smoke/1"]);
    expect(JSON.stringify(report)).not.toContain("test-key-primary");
    expect(gateway.requests.every((request) => request.maxOutputTokens === 800)).toBe(
      true
    );
  }, 120_000);
});
