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
};

export interface ProviderRegistry {
  validate(access: ProviderAccess): Promise<void>;
  listModels(access: ProviderAccess): Promise<ProviderModelSummary[]>;
}
