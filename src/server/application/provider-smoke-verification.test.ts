import { describe, expect, it } from "vitest";
import type {
  ModelEvent,
  ModelGateway
} from "@/server/application/model-gateway";
import { verifyProviderSmokeMatrix } from "@/server/application/provider-smoke-verification";
import {
  createProviderSmokeTestDependencies,
  createProviderSmokeTestGateway,
  PROVIDER_SMOKE_TEST_ENV
} from "@/server/test-support/provider-smoke-gateway";

function unusedGateway(): ModelGateway {
  return {
    async *run(): AsyncIterable<ModelEvent> {
      throw new Error("the smoke matrix must not call a Provider without opt-in");
    }
  };
}

describe("Provider smoke verification", () => {
  it(
    "skips without opt-in and never reaches a Provider",
    async () => {
      const result = await verifyProviderSmokeMatrix({
        env: {},
        dependencies: createProviderSmokeTestDependencies(unusedGateway())
      });

      expect(result.status).toBe("skipped");
      expect(result.message).toContain("opt-in");
      expect(result.report).toBeUndefined();
      expect(result.gate).toBeUndefined();
    },
    30_000
  );

  it(
    "emits a redacted report and release gate input when it passes",
    async () => {
      const result = await verifyProviderSmokeMatrix({
        env: { ...PROVIDER_SMOKE_TEST_ENV },
        dependencies: createProviderSmokeTestDependencies(
          createProviderSmokeTestGateway()
        )
      });

      expect(result.status).toBe("passed");
      expect(result.report?.passed).toBe(true);
      expect(result.gate).toEqual({
        enabled: true,
        passed: true,
        evidenceLink: "ci://provider-smoke/1"
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("test-key-primary");
      expect(serialized).not.toContain("test-key-fallback");
    },
    60_000
  );

  it(
    "reports a capped matrix as failed without pretending it passed",
    async () => {
      const result = await verifyProviderSmokeMatrix({
        env: { ...PROVIDER_SMOKE_TEST_ENV, SMOKE_MAX_TOTAL_TOKENS: "1" },
        dependencies: createProviderSmokeTestDependencies(
          createProviderSmokeTestGateway()
        )
      });

      expect(result.status).toBe("failed");
      expect(result.report?.totals.capReached).toBe(true);
      expect(result.report?.passed).toBe(false);
    },
    60_000
  );
});
