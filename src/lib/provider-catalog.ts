export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "deepseek",
  "groq",
  "mistral"
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const providerCatalog: ReadonlyArray<{
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
