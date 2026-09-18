import type { DiscussionBudget } from "@/server/domain/types";
import type {
  Approval,
  Artifact,
  Conversation,
  Discussion,
  Employee,
  Group,
  Message,
  ProviderCredential,
  Run,
  RunEvent,
  Skill,
  Source,
  Task,
  TaskAction,
  ToolDefinition
} from "@/server/domain/types";

export type PublicProvider = Omit<
  ProviderCredential,
  "encryptedCredential"
> & {
  configured: true;
};

export type WorkspaceView = {
  workspace: {
    id: string;
    name: string;
    discussionBudgetDefaults?: DiscussionBudget;
  };
  providers: PublicProvider[];
  employees: Employee[];
  skills: Skill[];
  tools: ToolDefinition[];
  groups: Group[];
  conversations: Conversation[];
  messages: Message[];
  runs: Run[];
  runEvents: RunEvent[];
  tasks: Array<Task & { availableActions: TaskAction[] }>;
  artifacts: Artifact[];
  sources: Source[];
  discussions: Discussion[];
  approvals: Approval[];
};
