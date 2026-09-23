import type {
  Tool,
  Approval,
  ApprovalDecision,
  Artifact,
  Conversation,
  Employee,
  Group,
  ProviderCredential,
  Skill,
  Task
} from "@/server/domain/types";
import {
  conversationInputSchema,
  conversationPatchSchema,
  employeeInputSchema,
  groupInputSchema,
  providerInputSchema,
  providerUpdateSchema,
  skillInputSchema,
  toolDraftSchema,
  taskInputSchema,
  taskPatchSchema,
  workspacePatchSchema
} from "@/server/domain/schemas";
import type { ProviderRegistry } from "@/server/application/provider-gateway";
import { ApiError, notFound } from "@/server/application/errors";
import { transitionTask } from "@/server/application/task-ledger";
import { createDraftTask } from "@/server/application/task-factory";
import { availableTaskActions } from "@/server/application/task-actions";
import { buildDiagnosticsView } from "@/server/application/diagnostics-view";
import { resolveConversationCitations } from "@/server/application/conversation-evidence";
import { buildUsageView } from "@/server/application/usage-view";
import type { DiagnosticsView } from "@/lib/diagnostics-view";
import type { UsageView, UsageWindow } from "@/lib/usage-view";
import {
  createTaskArtifact,
  updateTaskArtifact
} from "@/server/application/artifact-ledger";
import type { PublicTool, WorkspaceView } from "@/lib/workspace-view";
import type { CredentialCipher } from "@/server/security/credential-cipher";
import { publicSource } from "@/server/application/source-service";
import type { StateStore } from "@/server/store/store";

export type PublicProvider = WorkspaceView["providers"][number];

function now(): string {
  return new Date().toISOString();
}

/**
 * A Tool as the client sees it. The credential is replaced by whether one is
 * configured — the same shape `publicProvider` gives a Provider credential.
 */
function publicTool(tool: Tool): PublicTool {
  const { encryptedCredential, ...rest } = structuredClone(tool);
  return { ...rest, configured: encryptedCredential !== undefined };
}

function publicProvider(provider: ProviderCredential): PublicProvider {
  const rest: Omit<ProviderCredential, "encryptedCredential"> = {
    id: provider.id,
    workspaceId: provider.workspaceId,
    provider: provider.provider,
    label: provider.label,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    ...(provider.lastValidatedAt
      ? { lastValidatedAt: provider.lastValidatedAt }
      : {})
  };
  return { ...rest, configured: true };
}

export class WorkspaceService {
  constructor(
    private readonly store: StateStore,
    private readonly cipher: CredentialCipher,
    private readonly providers: ProviderRegistry
  ) {}

  async getWorkspaceView(): Promise<WorkspaceView> {
    return this.store.read((state) => ({
      workspace: {
        id: state.workspace.id,
        name: state.workspace.name,
        discussionBudgetDefaults:
          state.workspace.discussionBudgetDefaults,
        rerankChunks: state.workspace.rerankChunks
      },
      providers: state.providers.map(publicProvider),
      employees: state.employees,
      skills: state.skills,
      tools: state.tools.map(publicTool),
      groups: state.groups,
      conversations: state.conversations,
      messages: state.messages,
      runs: state.runs,
      runEvents: state.runEvents,
      tasks: state.tasks.map((task) => ({
        ...task,
        availableActions: availableTaskActions(state, task)
      })),
      artifacts: state.artifacts,
      sources: state.sources.map((source) => publicSource(source)),
      discussions: state.discussions,
      approvals: state.approvals,
      messageCitations: state.conversations.flatMap((conversation) =>
        resolveConversationCitations(state, conversation.id)
      )
    }));
  }

  async getDiagnosticsView(): Promise<DiagnosticsView> {
    return this.store.read((state) => buildDiagnosticsView(state));
  }

  async getUsageView(window?: UsageWindow): Promise<UsageView> {
    return this.store.read((state) => buildUsageView(state, { window }));
  }

  async updateWorkspace(input: unknown): Promise<WorkspaceView> {
    const parsed = workspacePatchSchema.parse(input);
    await this.store.update((state) => {
      if (parsed.discussionBudgetDefaults !== undefined) {
        state.workspace.discussionBudgetDefaults =
          parsed.discussionBudgetDefaults ?? undefined;
      }
      if (parsed.rerankChunks !== undefined) {
        state.workspace.rerankChunks = parsed.rerankChunks;
      }
      if (parsed.egressAllowlist !== undefined) {
        state.workspace.egressAllowlist = parsed.egressAllowlist;
      }
      state.workspace.updatedAt = new Date().toISOString();
    });
    return this.getWorkspaceView();
  }

  async listProviders(): Promise<PublicProvider[]> {
    return this.store.read((state) => state.providers.map(publicProvider));
  }

  async createProvider(input: unknown): Promise<PublicProvider> {
    const parsed = providerInputSchema.parse(input);
    await this.providers.validate({
      provider: parsed.provider,
      credential: parsed.credential
    });
    return this.store.update((state) => {
      const timestamp = now();
      const provider: ProviderCredential = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        provider: parsed.provider,
        label: parsed.label,
        encryptedCredential: this.cipher.encrypt(parsed.credential),
        lastValidatedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.providers.push(provider);
      state.workspace.updatedAt = timestamp;
      return publicProvider(provider);
    });
  }

  async updateProvider(id: string, input: unknown): Promise<PublicProvider> {
    const parsed = providerUpdateSchema.parse(input);
    const current = await this.store.read((state) =>
      state.providers.find((item) => item.id === id)
    );
    if (!current) notFound("Provider");
    if (parsed.provider !== current.provider && !parsed.credential) {
      throw new ApiError(
        400,
        "A new credential is required when changing the Provider",
        "credential_required"
      );
    }
    if (parsed.credential) {
      await this.providers.validate({
        provider: parsed.provider,
        credential: parsed.credential
      });
    }
    return this.store.update((state) => {
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) notFound("Provider");
      const timestamp = now();
      provider.provider = parsed.provider;
      provider.label = parsed.label;
      if (parsed.credential) {
        provider.encryptedCredential = this.cipher.encrypt(parsed.credential);
        provider.lastValidatedAt = timestamp;
      }
      provider.updatedAt = timestamp;
      state.workspace.updatedAt = provider.updatedAt;
      return publicProvider(provider);
    });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.store.update((state) => {
      const provider = state.providers.find((item) => item.id === id);
      if (!provider) notFound("Provider");
      if (
        state.employees.some(
          (employee) =>
            employee.providerCredentialId === id ||
            employee.fallbackTargets?.some(
              (target) => target.providerCredentialId === id
            )
        )
      ) {
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
      return this.providers.listModels({
        provider: provider.provider,
        credential: this.cipher.decrypt(provider.encryptedCredential)
      });
    });
  }

  async createEmployee(input: unknown): Promise<Employee> {
    const parsed = employeeInputSchema.parse(input);
    this.assertUniqueEmployeeTargets(parsed);
    await this.assertEmployeeModel(
      parsed.providerCredentialId,
      parsed.modelId
    );
    for (const target of parsed.fallbackTargets) {
      await this.assertEmployeeModel(
        target.providerCredentialId,
        target.modelId
      );
    }
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
    this.assertUniqueEmployeeTargets(parsed);
    const current = await this.store.read((state) => {
      const employee = state.employees.find((item) => item.id === id);
      if (!employee) notFound("Employee");
      return employee;
    });
    if (
      current.providerCredentialId !== parsed.providerCredentialId ||
      current.modelId !== parsed.modelId
    ) {
      await this.assertEmployeeModel(
        parsed.providerCredentialId,
        parsed.modelId
      );
    }
    const currentFallbackTargets = current.fallbackTargets ?? [];
    if (
      JSON.stringify(currentFallbackTargets) !==
      JSON.stringify(parsed.fallbackTargets)
    ) {
      for (const target of parsed.fallbackTargets) {
        await this.assertEmployeeModel(
          target.providerCredentialId,
          target.modelId
        );
      }
    }
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
      const knownTools = new Set(state.tools.map((tool) => tool.name));
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
      const knownTools = new Set(state.tools.map((tool) => tool.name));
      if (parsed.toolNames.some((name) => !knownTools.has(name))) {
        throw new ApiError(400, "Skill references an unknown Tool", "invalid_tool");
      }
      Object.assign(skill, parsed, { updatedAt: now() });
      state.workspace.updatedAt = skill.updatedAt;
      return skill;
    });
  }

  async createTool(input: unknown): Promise<PublicTool> {
    const parsed = toolDraftSchema.parse(input);
    return this.store.update((state) => {
      if (state.tools.some((tool) => tool.name === parsed.name)) {
        throw new ApiError(
          409,
          "A Tool with that name already exists",
          "tool_name_taken"
        );
      }
      const timestamp = now();
      const { credential, active, ...draft } = parsed;
      const tool: Tool = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        ...draft,
        builtIn: false,
        active: active ?? true,
        ...(credential ? { encryptedCredential: this.cipher.encrypt(credential) } : {}),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.tools.push(tool);
      state.workspace.updatedAt = timestamp;
      return publicTool(tool);
    });
  }

  async updateTool(id: string, input: unknown): Promise<PublicTool> {
    const parsed = toolDraftSchema.parse(input);
    return this.store.update((state) => {
      const tool = state.tools.find((item) => item.id === id);
      if (!tool) notFound("Tool");
      if (tool.builtIn) {
        throw new ApiError(
          409,
          "Built-in Tools cannot be edited",
          "builtin_tool"
        );
      }
      // Renaming is create-plus-delete: a Skill allows a Tool by name, so a
      // silent rename would change what an existing Skill calls.
      if (parsed.name !== tool.name) {
        throw new ApiError(
          409,
          "A Tool's name cannot change; create a new Tool instead",
          "tool_rename"
        );
      }
      const { credential, active, ...draft } = parsed;
      Object.assign(tool, draft);
      if (active !== undefined) tool.active = active;
      if (credential === null) delete tool.encryptedCredential;
      else if (credential !== undefined) {
        tool.encryptedCredential = this.cipher.encrypt(credential);
      }
      tool.updatedAt = now();
      state.workspace.updatedAt = tool.updatedAt;
      return publicTool(tool);
    });
  }

  async deleteTool(id: string): Promise<void> {
    return this.store.update((state) => {
      const index = state.tools.findIndex((item) => item.id === id);
      if (index === -1) notFound("Tool");
      const tool = state.tools[index];
      if (tool.builtIn) {
        throw new ApiError(
          409,
          "Built-in Tools cannot be deleted",
          "builtin_tool"
        );
      }
      // Skills are live configuration, not history: refusing the delete is what
      // keeps every Skill's toolNames resolvable, without a tombstone.
      const referencing = state.skills.filter((skill) =>
        skill.toolNames.includes(tool.name)
      );
      if (referencing.length > 0) {
        throw new ApiError(
          409,
          `Still allowed by ${referencing.map((skill) => skill.name).join(", ")}`,
          "tool_in_use"
        );
      }
      state.tools.splice(index, 1);
      state.workspace.updatedAt = now();
    });
  }

  async createGroup(input: unknown): Promise<Group> {
    const parsed = groupInputSchema.parse(input);
    return this.store.update((state) => {
      this.assertKnownEmployees(state.employees, parsed.memberIds);
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
      this.assertKnownEmployees(state.employees, parsed.memberIds);
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
      const memberIds = group
        ? group.memberIds.filter((id) =>
            state.employees.some(
              (employee) => employee.id === id && employee.active
            )
          )
        : parsed.memberIds;
      if (!group) {
        this.assertEmployees(state.employees, memberIds);
      }
      const timestamp = now();
      const conversation: Conversation = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        title: parsed.title,
        groupId: group?.id,
        memberIds,
        retrievalExcluded: false,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.conversations.push(conversation);
      state.workspace.updatedAt = timestamp;
      return conversation;
    });
  }

  /**
   * The single mutation path for a Conversation. A patch may carry either
   * field or both, and both are applied in one update — so a caller that sends
   * both never has one silently dropped.
   */
  async updateConversation(id: string, input: unknown): Promise<Conversation> {
    const patch = conversationPatchSchema.parse(input);
    return this.store.update((state) => {
      const conversation = state.conversations.find((item) => item.id === id);
      if (!conversation) notFound("Conversation");
      if (patch.memberIds !== undefined) {
        this.assertEmployees(state.employees, patch.memberIds);
        conversation.memberIds = [...new Set(patch.memberIds)];
      }
      if (patch.retrievalExcluded !== undefined) {
        conversation.retrievalExcluded = patch.retrievalExcluded;
      }
      conversation.updatedAt = now();
      state.workspace.updatedAt = conversation.updatedAt;
      return conversation;
    });
  }

  async updateConversationMembers(
    id: string,
    memberIds: string[]
  ): Promise<Conversation> {
    return this.updateConversation(id, { memberIds });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.store.update((state) => {
      const conversation = state.conversations.find((item) => item.id === id);
      if (!conversation) return;
      const activeRun = state.runs.find(
        (run) =>
          run.conversationId === id &&
          ["queued", "running", "waiting_approval"].includes(run.status)
      );
      if (activeRun) {
        throw new ApiError(
          409,
          "Stop the active Run before deleting this Conversation",
          "conversation_active_run"
        );
      }

      const runIds = new Set(
        state.runs
          .filter((run) => run.conversationId === id)
          .map((run) => run.id)
      );
      const taskIds = new Set(
        state.tasks
          .filter((task) => task.conversationId === id)
          .map((task) => task.id)
      );
      const discussionIds = new Set(
        state.discussions
          .filter((discussion) => discussion.conversationId === id)
          .map((discussion) => discussion.id)
      );

      state.conversations = state.conversations.filter(
        (item) => item.id !== id
      );
      state.messages = state.messages.filter(
        (message) => message.conversationId !== id
      );
      state.runs = state.runs.filter(
        (run) => !runIds.has(run.id)
      );
      state.runEvents = state.runEvents.filter(
        (event) => !runIds.has(event.runId)
      );
      state.tasks = state.tasks.filter((task) => !taskIds.has(task.id));
      state.discussions = state.discussions.filter(
        (discussion) => !discussionIds.has(discussion.id)
      );
      state.artifacts = state.artifacts.filter(
        (artifact) =>
          !(
            (artifact.ownerType === "task" &&
              taskIds.has(artifact.ownerId)) ||
            (artifact.ownerType === "discussion" &&
              discussionIds.has(artifact.ownerId))
          )
      );
      state.approvals = state.approvals.filter(
        (approval) =>
          !(
            runIds.has(approval.runId) ||
            (approval.taskId !== undefined &&
              taskIds.has(approval.taskId))
          )
      );
      state.workspace.updatedAt = now();
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
      const task = createDraftTask({
        workspaceId: state.workspace.id,
        conversationId,
        title: parsed.title,
        goal: parsed.goal,
        assigneeIds: parsed.assigneeIds,
        now: timestamp
      });
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
        task.history.push({
          status: task.status,
          at: now(),
          actorId,
          action: "assignees_updated"
        });
      }
      if (parsed.title) {
        task.title = parsed.title;
        task.history.push({
          status: task.status,
          at: now(),
          actorId,
          action: "title_updated"
        });
      }
      if (parsed.goal) {
        task.goal = parsed.goal;
        task.history.push({
          status: task.status,
          at: now(),
          actorId,
          action: "goal_updated"
        });
      }
      if (parsed.status) {
        transitionTask(task, parsed.status, actorId);
      }
      task.updatedAt = now();
      state.workspace.updatedAt = task.updatedAt;
      return task;
    });
  }

  async createArtifact(
    taskId: string,
    input: unknown,
    actorId = "user"
  ): Promise<Artifact> {
    return this.store.update((state) =>
      createTaskArtifact(state, taskId, input, actorId)
    );
  }

  async updateArtifact(
    taskId: string,
    artifactId: string,
    input: unknown,
    actorId = "user"
  ): Promise<Artifact> {
    return this.store.update((state) =>
      updateTaskArtifact(state, taskId, artifactId, input, actorId)
    );
  }

  async resolveApproval(
    id: string,
    decision: ApprovalDecision
  ): Promise<Approval> {
    return this.store.update((state) => {
      const approval = state.approvals.find((item) => item.id === id);
      if (!approval) notFound("Approval");
      if (approval.status !== "pending") {
        throw new ApiError(409, "Approval is already resolved", "approval_resolved");
      }
      const resolvedAt = now();
      if (
        approval.expiresAt &&
        Date.parse(approval.expiresAt) <= Date.now()
      ) {
        approval.status = "expired";
        approval.resolvedAt = resolvedAt;
        if (approval.taskId) {
          const task = state.tasks.find((item) => item.id === approval.taskId);
          if (
            task &&
            task.status !== "completed" &&
            task.status !== "cancelled"
          ) {
            transitionTask(task, "in_progress", "user");
          }
        }
        state.workspace.updatedAt = resolvedAt;
        return approval;
      }
      approval.status = decision;
      approval.resolvedAt = resolvedAt;
      if (approval.taskId) {
        const task = state.tasks.find((item) => item.id === approval.taskId);
        if (task && task.status !== "completed" && task.status !== "cancelled") {
          transitionTask(task, "in_progress", "user");
        }
      }
      state.workspace.updatedAt = resolvedAt;
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

  private assertKnownEmployees(employees: Employee[], ids: string[]): void {
    const knownIds = new Set(employees.map((employee) => employee.id));
    if (ids.some((id) => !knownIds.has(id))) {
      throw new ApiError(
        400,
        "One or more Employees are unknown",
        "invalid_employee"
      );
    }
  }

  private async assertEmployeeModel(
    providerCredentialId: string,
    modelId: string
  ): Promise<void> {
    const access = await this.store.read((state) => {
      const provider = state.providers.find(
        (item) => item.id === providerCredentialId
      );
      if (!provider) notFound("Provider");
      return {
        provider: provider.provider,
        credential: this.cipher.decrypt(provider.encryptedCredential)
      };
    });
    const models = await this.providers.listModels(access);
    const model = models.find((item) => item.id === modelId);
    if (!model || model.supportsStructuredOutput !== true) {
      throw new ApiError(
        400,
        model
          ? "Employee model does not support the required structured output"
          : "Employee model is not available from the selected provider",
        "invalid_model"
      );
    }
  }

  private assertUniqueEmployeeTargets(input: {
    providerCredentialId: string;
    modelId: string;
    fallbackTargets: Array<{
      providerCredentialId: string;
      modelId: string;
    }>;
  }): void {
    const targets = [
      {
        providerCredentialId: input.providerCredentialId,
        modelId: input.modelId
      },
      ...input.fallbackTargets
    ];
    const keys = targets.map(
      (target) => `${target.providerCredentialId}\0${target.modelId}`
    );
    if (new Set(keys).size !== keys.length) {
      throw new ApiError(
        400,
        "Employee fallback targets must be unique",
        "invalid_model"
      );
    }
  }

}
