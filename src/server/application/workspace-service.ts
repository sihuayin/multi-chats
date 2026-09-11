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
  TaskStatus
} from "@/server/domain/types";
import {
  artifactInputSchema,
  conversationInputSchema,
  employeeInputSchema,
  groupInputSchema,
  providerInputSchema,
  skillInputSchema,
  taskInputSchema,
  taskPatchSchema
} from "@/server/domain/schemas";
import {
  listProviderModels,
  validateProviderCredential
} from "@/server/adapters/model/provider-registry";
import { ApiError, notFound } from "@/server/application/errors";
import type { CredentialCipher } from "@/server/security/credential-cipher";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import type { StateStore } from "@/server/store/store";

export type PublicProvider = Omit<ProviderCredential, "encryptedCredential"> & {
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
  tools: typeof BUILT_IN_TOOLS;
  groups: Group[];
  conversations: Conversation[];
  messages: Message[];
  runs: Run[];
  runEvents: RunEvent[];
  tasks: Task[];
  artifacts: Artifact[];
  approvals: Approval[];
};

function now(): string {
  return new Date().toISOString();
}

function publicProvider(provider: ProviderCredential): PublicProvider {
  const rest: Omit<ProviderCredential, "encryptedCredential"> = {
    id: provider.id,
    workspaceId: provider.workspaceId,
    provider: provider.provider,
    label: provider.label,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt
  };
  return { ...rest, configured: true };
}

export class WorkspaceService {
  constructor(
    private readonly store: StateStore,
    private readonly cipher: CredentialCipher
  ) {}

  async getWorkspaceView(): Promise<WorkspaceView> {
    return this.store.read((state) => ({
      workspace: {
        id: state.workspace.id,
        name: state.workspace.name
      },
      providers: state.providers.map(publicProvider),
      employees: state.employees,
      skills: state.skills,
      tools: BUILT_IN_TOOLS,
      groups: state.groups,
      conversations: state.conversations,
      messages: state.messages,
      runs: state.runs,
      runEvents: state.runEvents,
      tasks: state.tasks,
      artifacts: state.artifacts,
      approvals: state.approvals
    }));
  }

  async listProviders(): Promise<PublicProvider[]> {
    return this.store.read((state) => state.providers.map(publicProvider));
  }

  async createProvider(input: unknown): Promise<PublicProvider> {
    const parsed = providerInputSchema.parse(input);
    await validateProviderCredential(parsed.provider, parsed.credential);
    return this.store.update((state) => {
      const timestamp = now();
      const provider: ProviderCredential = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        provider: parsed.provider,
        label: parsed.label,
        encryptedCredential: this.cipher.encrypt(parsed.credential),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.providers.push(provider);
      state.workspace.updatedAt = timestamp;
      return publicProvider(provider);
    });
  }

  async updateProvider(id: string, input: unknown): Promise<PublicProvider> {
    const parsed = providerInputSchema.parse(input);
    await validateProviderCredential(parsed.provider, parsed.credential);
    return this.store.update((state) => {
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) notFound("Provider");
      provider.provider = parsed.provider;
      provider.label = parsed.label;
      provider.encryptedCredential = this.cipher.encrypt(parsed.credential);
      provider.updatedAt = now();
      state.workspace.updatedAt = provider.updatedAt;
      return publicProvider(provider);
    });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.store.update((state) => {
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) notFound("Provider");
      if (state.employees.some((employee) => employee.providerCredentialId === id)) {
        throw new ApiError(
          409,
          "Provider is assigned to an Employee and cannot be deleted",
          "provider_in_use"
        );
      }
      state.providers = state.providers.filter((item) => item.id !== id);
      state.workspace.updatedAt = now();
    });
  }

  async listProviderModels(providerCredentialId: string) {
    return this.store.read((state) => {
      const provider = state.providers.find(
        (item) => item.id === providerCredentialId
      );
      if (!provider) notFound("Provider");
      return listProviderModels(
        provider.provider,
        this.cipher.decrypt(provider.encryptedCredential)
      );
    });
  }

  async createEmployee(input: unknown): Promise<Employee> {
    const parsed = employeeInputSchema.parse(input);
    return this.store.update((state) => {
      const provider = state.providers.find(
        (item) => item.id === parsed.providerCredentialId
      );
      if (!provider) notFound("Provider");
      const skillIds = new Set(state.skills.map((skill) => skill.id));
      if (parsed.skillIds.some((id) => !skillIds.has(id))) {
        throw new ApiError(400, "Employee contains an unknown Skill", "invalid_skill");
      }
      const timestamp = now();
      const employee: Employee = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        ...parsed,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.employees.push(employee);
      state.workspace.updatedAt = timestamp;
      return employee;
    });
  }

  async updateEmployee(id: string, input: unknown): Promise<Employee> {
    const parsed = employeeInputSchema.parse(input);
    return this.store.update((state) => {
      const employee = state.employees.find((item) => item.id === id);
      if (!employee) notFound("Employee");
      if (
        !state.providers.some(
          (provider) => provider.id === parsed.providerCredentialId
        )
      ) {
        notFound("Provider");
      }
      const validSkillIds = new Set(state.skills.map((skill) => skill.id));
      if (parsed.skillIds.some((skillId) => !validSkillIds.has(skillId))) {
        throw new ApiError(400, "Employee contains an unknown Skill", "invalid_skill");
      }
      Object.assign(employee, parsed, { updatedAt: now() });
      state.workspace.updatedAt = employee.updatedAt;
      return employee;
    });
  }

  async createSkill(input: unknown): Promise<Skill> {
    const parsed = skillInputSchema.parse(input);
    return this.store.update((state) => {
      const knownTools = new Set(BUILT_IN_TOOLS.map((tool) => tool.name));
      if (parsed.toolNames.some((name) => !knownTools.has(name))) {
        throw new ApiError(400, "Skill references an unknown Tool", "invalid_tool");
      }
      const timestamp = now();
      const skill: Skill = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        ...parsed,
        builtIn: false,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.skills.push(skill);
      state.workspace.updatedAt = timestamp;
      return skill;
    });
  }

  async updateSkill(id: string, input: unknown): Promise<Skill> {
    const parsed = skillInputSchema.parse(input);
    return this.store.update((state) => {
      const skill = state.skills.find((item) => item.id === id);
      if (!skill) notFound("Skill");
      if (skill.builtIn) {
        throw new ApiError(409, "Built-in Skills cannot be edited", "builtin_skill");
      }
      const knownTools = new Set(BUILT_IN_TOOLS.map((tool) => tool.name));
      if (parsed.toolNames.some((name) => !knownTools.has(name))) {
        throw new ApiError(400, "Skill references an unknown Tool", "invalid_tool");
      }
      Object.assign(skill, parsed, { updatedAt: now() });
      state.workspace.updatedAt = skill.updatedAt;
      return skill;
    });
  }

  async createGroup(input: unknown): Promise<Group> {
    const parsed = groupInputSchema.parse(input);
    return this.store.update((state) => {
      this.assertEmployees(state.employees, parsed.memberIds);
      const timestamp = now();
      const group: Group = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        name: parsed.name,
        memberIds: parsed.memberIds,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.groups.push(group);
      state.workspace.updatedAt = timestamp;
      return group;
    });
  }

  async updateGroup(id: string, input: unknown): Promise<Group> {
    const parsed = groupInputSchema.parse(input);
    return this.store.update((state) => {
      const group = state.groups.find((item) => item.id === id);
      if (!group) notFound("Group");
      this.assertEmployees(state.employees, parsed.memberIds);
      group.name = parsed.name;
      group.memberIds = parsed.memberIds;
      group.updatedAt = now();
      state.workspace.updatedAt = group.updatedAt;
      return group;
    });
  }

  async createConversation(input: unknown): Promise<Conversation> {
    const parsed = conversationInputSchema.parse(input);
    return this.store.update((state) => {
      const group = parsed.groupId
        ? state.groups.find((item) => item.id === parsed.groupId)
        : undefined;
      if (parsed.groupId && !group) notFound("Group");
      const memberIds = group ? [...group.memberIds] : parsed.memberIds;
      this.assertEmployees(state.employees, memberIds);
      const timestamp = now();
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        title: parsed.title,
        groupId: group?.id,
        memberIds,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.conversations.push(conversation);
      state.workspace.updatedAt = timestamp;
      return conversation;
    });
  }

  async updateConversationMembers(
    id: string,
    memberIds: string[]
  ): Promise<Conversation> {
    return this.store.update((state) => {
      const conversation = state.conversations.find((item) => item.id === id);
      if (!conversation) notFound("Conversation");
      this.assertEmployees(state.employees, memberIds);
      conversation.memberIds = [...new Set(memberIds)];
      conversation.updatedAt = now();
      state.workspace.updatedAt = conversation.updatedAt;
      return conversation;
    });
  }

  async createTask(conversationId: string, input: unknown): Promise<Task> {
    const parsed = taskInputSchema.parse(input);
    return this.store.update((state) => {
      const conversation = state.conversations.find(
        (item) => item.id === conversationId
      );
      if (!conversation) notFound("Conversation");
      this.assertEmployees(state.employees, parsed.assigneeIds);
      const timestamp = now();
      const task: Task = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId,
        title: parsed.title,
        goal: parsed.goal,
        assigneeIds: parsed.assigneeIds,
        status: "draft",
        history: [{ status: "draft", at: timestamp, actorId: "user" }],
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.tasks.push(task);
      state.workspace.updatedAt = timestamp;
      return task;
    });
  }

  async updateTask(id: string, input: unknown, actorId: string): Promise<Task> {
    const parsed = taskPatchSchema.parse(input);
    return this.store.update((state) => {
      const task = state.tasks.find((item) => item.id === id);
      if (!task) notFound("Task");
      if (parsed.assigneeIds) {
        this.assertEmployees(state.employees, parsed.assigneeIds);
        task.assigneeIds = parsed.assigneeIds;
      }
      if (parsed.title) task.title = parsed.title;
      if (parsed.goal) task.goal = parsed.goal;
      if (parsed.status) {
        this.assertTaskTransition(task.status, parsed.status, actorId);
        task.status = parsed.status;
        task.history.push({ status: parsed.status, at: now(), actorId });
      }
      task.updatedAt = now();
      state.workspace.updatedAt = task.updatedAt;
      return task;
    });
  }

  async createArtifact(taskId: string, input: unknown): Promise<Artifact> {
    const parsed = artifactInputSchema.parse(input);
    return this.store.update((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task) notFound("Task");
      if (parsed.type === "json") {
        try {
          JSON.parse(parsed.content);
        } catch {
          throw new ApiError(400, "JSON Artifact content is invalid", "invalid_json");
        }
      }
      const timestamp = now();
      const artifact: Artifact = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        taskId,
        ...parsed,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.artifacts.push(artifact);
      state.workspace.updatedAt = timestamp;
      return artifact;
    });
  }

  async resolveApproval(
    id: string,
    decision: Approval["status"]
  ): Promise<Approval> {
    return this.store.update((state) => {
      const approval = state.approvals.find((item) => item.id === id);
      if (!approval) notFound("Approval");
      if (approval.status !== "pending") {
        throw new ApiError(409, "Approval is already resolved", "approval_resolved");
      }
      approval.status = decision;
      approval.resolvedAt = now();
      state.workspace.updatedAt = approval.resolvedAt;
      return approval;
    });
  }

  private assertEmployees(employees: Employee[], ids: string[]): void {
    const activeIds = new Set(
      employees.filter((employee) => employee.active).map((employee) => employee.id)
    );
    if (ids.some((id) => !activeIds.has(id))) {
      throw new ApiError(400, "One or more Employees are unknown or inactive", "invalid_employee");
    }
  }

  private assertTaskTransition(
    current: TaskStatus,
    next: TaskStatus,
    actorId: string
  ): void {
    const employeeTransitions: Partial<Record<TaskStatus, TaskStatus[]>> = {
      draft: ["in_progress", "blocked", "cancelled"],
      in_progress: ["blocked", "review", "cancelled"],
      blocked: ["in_progress", "review", "cancelled"],
      review: ["in_progress"]
    };
    if (next === "completed") {
      if (actorId !== "user") {
        throw new ApiError(403, "Only the user can complete a Task", "task_completion");
      }
      if (current !== "review") {
        throw new ApiError(409, "Task must be in review before completion", "task_transition");
      }
      return;
    }
    if (next === "cancelled" && actorId === "user") return;
    const allowed = employeeTransitions[current] ?? [];
    if (!allowed.includes(next)) {
      throw new ApiError(
        409,
        `Task cannot move from ${current} to ${next}`,
        "task_transition"
      );
    }
  }
}
