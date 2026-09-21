import type { DiscussionBudget, Tool } from "@/server/domain/types";

/**
 * A Tool as the client sees it: the credential is replaced by whether one is
 * configured, mirroring `PublicProvider`.
 */
export type PublicTool = Omit<Tool, "encryptedCredential"> & {
  configured: boolean;
};
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
  TaskAction
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
    rerankChunks?: boolean;
  };
  providers: PublicProvider[];
  employees: Employee[];
  skills: Skill[];
  tools: PublicTool[];
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
