import {
  createModels,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Models,
  type Provider
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { ProviderId } from "@/server/domain/types";

const factories: Record<ProviderId, () => Provider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
  deepseek: deepseekProvider,
  groq: groqProvider,
  mistral: mistralProvider
};

class StaticCredentialStore implements CredentialStore {
  constructor(private readonly credential?: Credential) {}

  async read(): Promise<Credential | undefined> {
    return this.credential;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.credential
      ? [{ providerId: "configured", type: this.credential.type }]
      : [];
  }

  async modify(): Promise<Credential | undefined> {
    return this.credential;
  }

  async delete(): Promise<void> {}
}

export const providerDescriptions: Array<{
  id: ProviderId;
  label: string;
}> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "groq", label: "Groq" },
  { id: "mistral", label: "Mistral" }
];

export function createProviderModels(
  providerId: ProviderId,
  credential?: string
): Models {
  const credentials = new StaticCredentialStore(
    credential ? { type: "api_key", key: credential } : undefined
  );

  const models = createModels({ credentials });
  models.setProvider(factories[providerId]());
  return models;
}

export function listProviderModels(
  providerId: ProviderId,
  credential?: string
): Array<{
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
}> {
  return createProviderModels(providerId, credential)
    .getModels(providerId)
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: Boolean(model.reasoning)
    }));
}

export async function validateProviderCredential(
  providerId: ProviderId,
  credential: string
): Promise<void> {
  const models = createProviderModels(providerId, credential);
  const auth = await models.getAuth(providerId);
  if (!auth) {
    throw new Error("The provider credential could not be resolved");
  }
  if (models.getModels(providerId).length === 0) {
    throw new Error("No models are available for this provider");
  }
}
