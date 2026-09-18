import type {
  ModelEvent,
  ModelGateway,
  ModelRequest
} from "@/server/application/model-gateway";
import {
  resolveProviderSmokeConfig,
  type ProviderSmokeEnvironment,
  type ProviderSmokeRunConfig
} from "@/server/application/provider-smoke";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { createFixtureBrief, TEST_KEY } from "@/server/test-support/fixtures";

export const PROVIDER_SMOKE_TEST_EVIDENCE_REFERENCE =
  "external:https://example.com/smoke";

/** Opt-in environment shared by the Provider smoke tests. */
export const PROVIDER_SMOKE_TEST_ENV = {
  PROVIDER_SMOKE: "1",
  SMOKE_PRIMARY_PROVIDER: "openai",
  SMOKE_PRIMARY_MODEL: "gpt-4o-mini",
  SMOKE_PRIMARY_API_KEY: "test-key-primary",
  SMOKE_FALLBACK_PROVIDER: "anthropic",
  SMOKE_FALLBACK_MODEL: "claude-3-5-haiku",
  SMOKE_FALLBACK_API_KEY: "test-key-fallback",
  SMOKE_EVIDENCE_LINK: "ci://provider-smoke/1"
} as const;

/** The opt-in smoke config the Provider smoke tests run with. */
export function resolveProviderSmokeTestConfig(
  overrides: ProviderSmokeEnvironment = {}
): ProviderSmokeRunConfig {
  const resolved = resolveProviderSmokeConfig({
    ...PROVIDER_SMOKE_TEST_ENV,
    ...overrides
  });
  if (!resolved.enabled) {
    throw new Error("expected an enabled Provider smoke config");
  }
  return resolved;
}

export type ProviderSmokeTestGateway = ModelGateway & {
  requests: ModelRequest[];
};

function responseFor(request: ModelRequest): string {
  if (request.purpose === "discussion_rerank") {
    const ids = [...request.prompt.matchAll(/^- ([\w-]+):/gm)].map(
      (match) => match[1]
    );
    return JSON.stringify({ order: ids });
  }
  if (request.systemPrompt.includes("Compress the supplied Discussion history")) {
    return JSON.stringify({
      highlights: [
        {
          statement: "Historical analysis",
          evidenceIds: [PROVIDER_SMOKE_TEST_EVIDENCE_REFERENCE]
        }
      ]
    });
  }
  if (request.systemPrompt.includes("Phase: synthesis")) {
    return JSON.stringify(
      createFixtureBrief(
        request.prompt.match(/Discussion ID: ([^\n]+)/)?.[1] ?? "smoke"
      )
    );
  }
  const phase = request.systemPrompt.includes("Phase: cross_response")
    ? "cross_response"
    : "positions";
  return JSON.stringify({
    summary: `${phase} summary`,
    claims: [
      {
        statement: `${phase} claim`,
        kind: "fact",
        evidenceIds: [PROVIDER_SMOKE_TEST_EVIDENCE_REFERENCE],
        confidence: "high"
      }
    ],
    assumptions: [],
    risks: [],
    openQuestions: [],
    ...(phase === "cross_response"
      ? { agreements: [], disagreements: [], corrections: [] }
      : {})
  });
}

/**
 * A deterministic ModelGateway that answers every Discussion phase the smoke
 * matrix exercises, so the matrix can be proven without live credentials.
 */
export function createProviderSmokeTestGateway(): ProviderSmokeTestGateway {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *run(request: ModelRequest): AsyncIterable<ModelEvent> {
      requests.push(request);
      const text = responseFor(request);
      yield { type: "text_delta", delta: text };
      yield { type: "text_completed", text };
      yield {
        type: "usage",
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          totalTokens: 160,
          source: "provider"
        },
        responseModel: request.modelId
      };
    }
  };
}

/** Runner dependencies that keep the smoke matrix offline and deterministic. */
export function createProviderSmokeTestDependencies(
  gateway: ModelGateway
): {
  gateway: ModelGateway;
  cipher: AesCredentialCipher;
  modelContext: () => {
    contextWindow: number;
    maxOutputTokens: number;
    available: boolean;
    supportsStructuredOutput: boolean;
  };
  clock: () => string;
} {
  return {
    gateway,
    cipher: new AesCredentialCipher(TEST_KEY),
    modelContext: () => ({
      contextWindow: 200_000,
      maxOutputTokens: 4_096,
      available: true,
      supportsStructuredOutput: true
    }),
    clock: () => "2026-01-01T00:00:00.000Z"
  };
}
