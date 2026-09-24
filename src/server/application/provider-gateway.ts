import type { ProviderId } from "@/server/domain/types";

export type ProviderAccess = {
  provider: ProviderId;
  credential: string;
};

export type ProviderModelSummary = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  supportsStructuredOutput?: boolean;
};

/**
 * How a caller bounds a validation. The adapters supply no timeout of their
 * own — the SDKs behind them default to ten minutes — so a caller that needs an
 * answer sooner has to bring its own signal.
 */
export type ProviderValidationOptions = {
  signal?: AbortSignal;
};

export interface ProviderRegistry {
  validate(
    access: ProviderAccess,
    options?: ProviderValidationOptions
  ): Promise<void>;
  listModels(access: ProviderAccess): Promise<ProviderModelSummary[]>;
}
