import type { ToolDefinition } from "@/server/domain/types";
import type { TranslationKey } from "@/lib/i18n";

const toolKeys: Record<
  string,
  { label: TranslationKey; description: TranslationKey }
> = {
  current_time: {
    label: "tools.currentTime.label",
    description: "tools.currentTime.description"
  },
  fetch_url: {
    label: "tools.fetchUrl.label",
    description: "tools.fetchUrl.description"
  },
  post_webhook: {
    label: "tools.postWebhook.label",
    description: "tools.postWebhook.description"
  },
  update_task: {
    label: "tools.updateTask.label",
    description: "tools.updateTask.description"
  },
  attach_artifact: {
    label: "tools.attachArtifact.label",
    description: "tools.attachArtifact.description"
  }
};

export function toolLabel(
  t: (key: TranslationKey) => string,
  tool: ToolDefinition
): string {
  const key = toolKeys[tool.name]?.label;
  return key ? t(key) : tool.label;
}

export function toolDescription(
  t: (key: TranslationKey) => string,
  tool: ToolDefinition
): string {
  const key = toolKeys[tool.name]?.description;
  return key ? t(key) : tool.description;
}
