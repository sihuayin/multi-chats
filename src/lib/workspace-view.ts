import type { DiscussionBudget, IsoDate, Tool } from "@/server/domain/types";

/**
 * A Tool as the client sees it: the credential is replaced by whether one is
 * configured, mirroring `PublicProvider`.
 */
export type PublicTool = Omit<Tool, "encryptedCredential"> & {
  configured: boolean;
};
import type { MessageCitation } from "@/server/application/conversation-evidence";
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

/**
 * The outcome of an on-demand Provider connection test. `latencyMs` spans the
 * whole check — credential decryption through the Provider's reply — not just
 * the time on the wire.
 */
export type ProviderConnectionTest = {
  status: "ok";
  latencyMs: number;
  validatedAt: IsoDate;
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
  /**
   * Per-message citation resolution for the Conversation surface: which
   * aliases in which published Messages resolve, to what Source and passage.
   */
  messageCitations: MessageCitation[];
};
