import type {
  Approval,
  Artifact,
  Conversation,
  Employee,
  Group,
  Message,
  ProviderCredential,
  Run,
  RunEvent,
  Skill,
  Task,
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
  tasks: Task[];
  artifacts: Artifact[];
  approvals: Approval[];
};
