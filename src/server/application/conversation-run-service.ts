import type {
  AppState,
  Approval,
  Employee,
  Message,
  Run,
  RunEvent,
  ToolDefinition
} from "@/server/domain/types";
import type {
  ModelEvent,
  ModelGateway,
  ModelTool
} from "@/server/application/model-gateway";
import { ApiError, notFound } from "@/server/application/errors";
import { appendEvent } from "@/server/application/run-ledger";
import { transitionTask } from "@/server/application/task-ledger";
import {
  RegisteredToolGateway,
  type ToolExecutionResult,
  type ToolGateway
} from "@/server/application/tool-gateway";
import { messageInputSchema } from "@/server/domain/schemas";
import type { CredentialCipher } from "@/server/security/credential-cipher";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import type { StateStore } from "@/server/store/store";

export type StartTurnResult = {
  message: Message;
  run: Run | null;
};

type ToolCallContext = {
  runId: string;
  messageId: string;
  employeeId: string;
  allowedToolNames: string[];
  tool: ToolDefinition;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
};

function now(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseMentions(
  content: string,
  employees: Employee[]
): { all: boolean; employeeIds: string[] } {
  const mentions = [...content.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((match) =>
    match[1].toLowerCase()
  );
  const bySlug = new Map(
    employees.map((employee) => [slugify(employee.name), employee.id])
  );
  const employeeIds = mentions
    .map((mention) => bySlug.get(mention))
    .filter((id): id is string => Boolean(id));

  return {
    all: mentions.includes("all"),
    employeeIds
  };
}

function transcriptFor(state: AppState, conversationId: string): string {
  return state.messages
    .filter(
      (message) =>
        message.conversationId === conversationId &&
        message.status === "complete"
    )
    .map((message) => {
      const author =
        message.authorType === "user"
          ? "User"
          : state.employees.find((employee) => employee.id === message.authorId)?.name ??
            "Employee";
      return `${author}: ${message.content}`;
    })
    .join("\n\n");
}

function taskContext(state: AppState, conversationId: string, employeeId: string): string {
  const tasks = state.tasks.filter(
    (task) =>
      task.conversationId === conversationId &&
      task.status !== "completed" &&
      task.status !== "cancelled" &&
      (task.assigneeIds.length === 0 || task.assigneeIds.includes(employeeId))
  );
  if (tasks.length === 0) return "No active tasks.";
  return tasks
    .map(
      (task) =>
        `Task ${task.id} "${task.title}" [${task.status}]: ${task.goal}${
          task.assigneeIds.includes(employeeId) ? " (assigned to you)" : ""
        }`
    )
    .join("\n");
}

function toolDefinitionsForEmployee(
  state: AppState,
  employee: Employee
): ToolDefinition[] {
  const skillIds = new Set(employee.skillIds);
  const allowedTools = new Set(
    state.skills
      .filter((skill) => skillIds.has(skill.id))
      .flatMap((skill) => skill.toolNames)
  );
  return BUILT_IN_TOOLS.filter((tool) => allowedTools.has(tool.name));
}

function settleApproval(
  state: AppState,
  runId: string,
  approval: Approval
): void {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return;
  if (run.status !== "cancelled") {
    run.status = "running";
  }
  appendEvent(state, run, "approval_resolved", {
    approvalId: approval.id,
    status: approval.status
  });
}

export class ConversationRunService {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly toolGateway: ToolGateway;

  constructor(
    private readonly store: StateStore,
    private readonly cipher: CredentialCipher,
    private readonly gateway: ModelGateway,
    private readonly options: {
      approvalTimeoutMs?: number;
      toolGateway?: ToolGateway;
    } = {}
  ) {
    this.toolGateway =
      options.toolGateway ?? new RegisteredToolGateway(store);
  }

  async recoverInterruptedRuns(): Promise<void> {
    await this.store.update((state) => {
      for (const run of state.runs) {
        if (run.status === "running" || run.status === "waiting_approval") {
          run.status = "interrupted";
          run.error = "Worker restarted while the Run was active";
          run.completedAt = now();
          for (const message of state.messages) {
            if (message.runId === run.id && message.status === "streaming") {
              message.status = "interrupted";
              message.updatedAt = run.completedAt;
              appendEvent(state, run, "employee_turn_interrupted", {
                employeeId: message.authorId,
                messageId: message.id
              });
            }
          }
          for (const approval of state.approvals) {
            if (approval.runId === run.id && approval.status === "pending") {
              approval.status = "cancelled";
              approval.resolvedAt = run.completedAt;
              appendEvent(state, run, "approval_resolved", {
                approvalId: approval.id,
                status: "cancelled",
                reason: "worker_restart"
              });
            }
          }
          appendEvent(state, run, "run_error", {
            message: run.error,
            interrupted: true
          });
        }
      }
    });
  }

  async startTurn(conversationId: string, input: unknown): Promise<StartTurnResult> {
    const parsed = messageInputSchema.parse(input);
    return this.store.update((state) => {
      const conversation = state.conversations.find(
        (item) => item.id === conversationId
      );
      if (!conversation) notFound("Conversation");
      const activeRun = state.runs.find(
        (run) =>
          run.conversationId === conversationId &&
          ["queued", "running", "waiting_approval"].includes(run.status)
      );
      if (activeRun) {
        throw new ApiError(
          409,
          "This Conversation already has an active Run",
          "active_run"
        );
      }

      const timestamp = now();
      const message: Message = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId,
        authorType: "user",
        authorId: "user",
        content: parsed.content,
        status: "complete",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.messages.push(message);

      const members = conversation.memberIds
        .map((id) => state.employees.find((employee) => employee.id === id))
        .filter((employee): employee is Employee => Boolean(employee?.active));
      const mentioned = parseMentions(parsed.content, members);
      const memberSnapshot = mentioned.all
        ? members.map((employee) => employee.id)
        : members
            .filter((employee) => mentioned.employeeIds.includes(employee.id))
            .map((employee) => employee.id);

      if (memberSnapshot.length === 0) {
        return { message, run: null };
      }

      const run: Run = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId,
        triggerMessageId: message.id,
        memberSnapshot,
        status: "queued",
        createdAt: timestamp
      };
      state.runs.push(run);
      message.runId = run.id;
      appendEvent(state, run, "run_started", {
        triggerMessageId: message.id,
        memberSnapshot
      });
      state.workspace.updatedAt = timestamp;
      return { message, run };
    });
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    return this.store.read((state) =>
      state.messages.filter((message) => message.conversationId === conversationId)
    );
  }

  async listRunEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    return this.store.read((state) =>
      state.runEvents
        .filter(
          (event) => event.runId === runId && event.sequence > afterSequence
        )
        .sort((left, right) => left.sequence - right.sequence)
    );
  }

  async getRunById(runId: string): Promise<Run | null> {
    return this.store.read(
      (state) => state.runs.find((item) => item.id === runId) ?? null
    );
  }

  async cancelRun(runId: string): Promise<Run> {
    const controller = this.activeControllers.get(runId);
    controller?.abort();
    const stopRequested = Boolean(controller);
    return this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      if (["completed", "failed", "cancelled"].includes(run.status)) return run;
      const timestamp = now();
      for (const approval of state.approvals) {
        if (approval.runId === runId && approval.status === "pending") {
          approval.status = "cancelled";
          approval.resolvedAt = timestamp;
        }
      }
      for (const message of state.messages) {
        if (message.runId === runId && message.status === "streaming") {
          message.status = "cancelled";
          message.updatedAt = timestamp;
          appendEvent(state, run, "employee_turn_cancelled", {
            employeeId: message.authorId,
            messageId: message.id,
            cooperative: true,
            stopRequested
          });
        }
      }
      run.status = "cancelled";
      run.completedAt = timestamp;
      appendEvent(state, run, "run_cancelled", {
        cooperative: true,
        stopRequested
      });
      state.workspace.updatedAt = timestamp;
      return run;
    });
  }

  async resumeRun(runId: string): Promise<Run> {
    return this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      if (run.status !== "interrupted") {
        throw new ApiError(
          409,
          "Only interrupted Runs can be resumed",
          "run_resume"
        );
      }
      for (const message of state.messages) {
        if (message.runId === runId && message.status === "streaming") {
          message.status = "cancelled";
          message.updatedAt = now();
        }
      }
      run.status = "queued";
      run.error = undefined;
      run.startedAt = undefined;
      run.completedAt = undefined;
      appendEvent(state, run, "run_started", { resumed: true });
      state.workspace.updatedAt = now();
      return run;
    });
  }

  async processNextQueuedRun(signal?: AbortSignal): Promise<boolean> {
    const run = await this.store.read(
      (state) => state.runs.find((item) => item.status === "queued") ?? null
    );
    if (!run) return false;
    await this.processRun(run.id, signal);
    return true;
  }

  async processRun(runId: string, signal?: AbortSignal): Promise<Run> {
    const controller = new AbortController();
    let cancellationPoll: ReturnType<typeof setInterval> | undefined;
    this.activeControllers.set(runId, controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const claimed = await this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        if (run.status !== "queued") return false;
        run.status = "running";
        run.startedAt = now();
        state.workspace.updatedAt = run.startedAt;
        return true;
      });
      const initial = await this.store.read((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        return structuredClone(run);
      });
      if (!claimed) return initial;
      cancellationPoll = setInterval(() => {
        void this.store
          .read((state) => state.runs.find((item) => item.id === runId)?.status)
          .then((status) => {
            if (status === "cancelled") controller.abort();
          })
          .catch(() => undefined);
      }, 300);

      const completedEmployeeIds = await this.store.read(
        (state) =>
          new Set(
            state.runEvents
              .filter(
                (event) =>
                  event.runId === runId && event.type === "message_completed"
              )
              .map((event) => String(event.payload.employeeId ?? ""))
          )
      );

      for (const employeeId of initial.memberSnapshot) {
        if (completedEmployeeIds.has(employeeId)) continue;
        if (controller.signal.aborted) break;
        await this.processEmployeeTurn(
          runId,
          employeeId,
          initial.triggerMessageId,
          controller.signal
        );
      }

      return this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        if (controller.signal.aborted || run.status === "cancelled") return run;
        run.status = "completed";
        run.completedAt = now();
        appendEvent(state, run, "run_completed", {});
        state.workspace.updatedAt = run.completedAt;
        return run;
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return this.store.update((state) => {
          const run = state.runs.find((item) => item.id === runId);
          if (!run) notFound("Run");
          if (run.status !== "cancelled") {
            run.status = "cancelled";
            run.completedAt = now();
            for (const message of state.messages) {
              if (message.runId === runId && message.status === "streaming") {
                message.status = "cancelled";
                message.updatedAt = run.completedAt;
                appendEvent(state, run, "employee_turn_cancelled", {
                  employeeId: message.authorId,
                  messageId: message.id
                });
              }
            }
            appendEvent(state, run, "run_cancelled", {});
          }
          return run;
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        if (!run) notFound("Run");
        run.status = "failed";
        run.error = message;
        run.completedAt = now();
        for (const current of state.messages) {
          if (current.runId === runId && current.status === "streaming") {
            current.status = "failed";
            current.updatedAt = run.completedAt;
            appendEvent(state, run, "employee_turn_failed", {
              employeeId: current.authorId,
              messageId: current.id,
              message
            });
          }
        }
        appendEvent(state, run, "run_error", { message });
        state.workspace.updatedAt = run.completedAt;
        return run;
      });
    } finally {
      if (cancellationPoll) clearInterval(cancellationPoll);
      signal?.removeEventListener("abort", abort);
      this.activeControllers.delete(runId);
    }
  }

  private async processEmployeeTurn(
    runId: string,
    employeeId: string,
    triggerMessageId: string,
    signal: AbortSignal
  ): Promise<void> {
    const context = await this.store.read((state) => {
      const run = state.runs.find((item) => item.id === runId);
      const employee = state.employees.find((item) => item.id === employeeId);
      const trigger = state.messages.find((item) => item.id === triggerMessageId);
      if (!run || !employee || !trigger) {
        throw new Error("Run context is incomplete");
      }
      const credential = state.providers.find(
        (provider) => provider.id === employee.providerCredentialId
      );
      if (!credential) throw new Error("Employee provider is missing");
      const skills = employee.skillIds
        .map((id) => state.skills.find((skill) => skill.id === id))
        .filter((skill): skill is NonNullable<typeof skill> => Boolean(skill));
      return {
        run: structuredClone(run),
        employee: structuredClone(employee),
        provider: credential.provider,
        encryptedCredential: credential.encryptedCredential,
        transcript: transcriptFor(state, run.conversationId),
        taskContext: taskContext(state, run.conversationId, employeeId),
        tools: toolDefinitionsForEmployee(state, employee),
        skills: structuredClone(skills)
      };
    });

    const message = await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      const timestamp = now();
      const message: Message = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        conversationId: run.conversationId,
        authorType: "employee",
        authorId: employeeId,
        content: "",
        runId,
        status: "streaming",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      state.messages.push(message);
      appendEvent(state, run, "employee_turn_started", {
        employeeId,
        messageId: message.id
      });
      return structuredClone(message);
    });

    const allowedToolNames = context.tools.map((tool) => tool.name);
    const modelTools: ModelTool[] = context.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      inputSchema: tool.inputSchema,
      replay: tool.replay,
      execute: (toolCallId, args, toolSignal) =>
        this.executeTool({
          runId,
          messageId: message.id,
          employeeId,
          allowedToolNames,
          tool,
          toolCallId,
          args,
          signal: toolSignal
        })
    }));

    const systemPrompt = [
      `You are ${context.employee.name}.`,
      context.employee.identity,
      ...context.skills.map(
        (skill) =>
          `Skill: ${skill.name}\n${skill.instructions}\nInputs: ${skill.inputs.join(", ")}\nOutputs: ${skill.outputs.join(", ")}`
      ),
      "Respond in the active Conversation. Do not claim to have used a Tool unless its result appears in the run."
    ].join("\n\n");

    const prompt = [
      `Conversation transcript:\n${context.transcript}`,
      `Active task context:\n${context.taskContext}`,
      `Current user request:\n${context.run.memberSnapshot.length > 1 ? "Respond as your assigned role and account for earlier responses in this Run." : ""}`,
      "Return a concise, useful response."
    ]
      .filter(Boolean)
      .join("\n\n");

    let finalText = "";
    let completed = false;
    let attempt = 0;
    while (attempt < 2 && !completed) {
      attempt += 1;
      let producedOutput = false;
      let retryableError = false;
      try {
        for await (const event of this.gateway.run({
          provider: context.provider,
          credential: this.cipher.decrypt(context.encryptedCredential),
          modelId: context.employee.modelId,
          systemPrompt,
          prompt,
          tools: modelTools,
          signal
        })) {
          await this.recordModelEvent(runId, message.id, event);
          if (event.type === "text_delta" || event.type === "tool_started") {
            producedOutput = true;
          }
          if (event.type === "text_delta") finalText += event.delta;
          if (event.type === "text_completed" && event.text) finalText = event.text;
          if (event.type === "error") {
            retryableError = event.kind === "retryable";
            throw new Error(event.message);
          }
        }
        if (signal.aborted) throw new Error("Run cancelled");
        completed = true;
      } catch (error) {
        if (signal.aborted || !retryableError || attempt >= 2 || producedOutput) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!completed) {
      throw new Error("Employee Run did not complete after retry");
    }

    await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      const current = state.messages.find((item) => item.id === message.id);
      if (!run || !current) notFound("Run");
      current.content = finalText;
      current.status = "complete";
      current.updatedAt = now();
      appendEvent(state, run, "message_completed", {
        messageId: current.id,
        employeeId
      });
      appendEvent(state, run, "employee_turn_completed", {
        messageId: current.id,
        employeeId
      });
      state.workspace.updatedAt = current.updatedAt;
    });
  }

  private async recordModelEvent(
    runId: string,
    messageId: string,
    event: ModelEvent
  ): Promise<void> {
    await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      const message = state.messages.find((item) => item.id === messageId);
      if (!run || !message) return;

      if (event.type === "text_delta") {
        message.content += event.delta;
        message.updatedAt = now();
        appendEvent(state, run, "message_delta", {
          messageId,
          delta: event.delta
        });
      }
      if (event.type === "tool_started") {
        appendEvent(state, run, "tool_started", {
          messageId,
          ...event
        });
      }
      if (event.type === "tool_completed") {
        appendEvent(state, run, "tool_completed", {
          messageId,
          ...event
        });
        if (event.isError) {
          appendEvent(
            state,
            run,
            event.errorKind === "cancelled" ? "tool_cancelled" : "tool_error",
            {
              messageId,
              ...event
            }
          );
        }
      }
      if (event.type === "error") {
        appendEvent(state, run, "model_error", {
          messageId,
          message: event.message,
          kind: event.kind ?? "terminal"
        });
      }
    });
  }

  private async executeTool(
    context: ToolCallContext
  ): Promise<ToolExecutionResult> {
    const { runId, employeeId, allowedToolNames, tool, args } = context;
    if (tool.requiresApproval) {
      const approval = await this.requestApproval(context);
      if (approval.status === "rejected") {
        return {
          content: "The user rejected this Tool call.",
          details: { approvalId: approval.id },
          isError: true,
          errorKind: "unauthorized"
        };
      }
      if (approval.status === "cancelled" || approval.status === "expired") {
        return {
          content: `Tool approval ${approval.status}.`,
          details: { approvalId: approval.id },
          isError: true,
          errorKind: "cancelled"
        };
      }
    }

    try {
      return await this.toolGateway.execute({
        tool,
        args,
        context: {
          runId,
          employeeId,
          allowedToolNames
        },
        signal: context.signal
      });
    } catch (error) {
      if (context.signal?.aborted) {
        return {
          content: "Tool call cancelled.",
          isError: true,
          errorKind: "cancelled"
        };
      }
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
        errorKind: "execution"
      };
    }
  }

  private async requestApproval(context: ToolCallContext) {
    const { runId, messageId, employeeId, tool, toolCallId, args } = context;
    const timeoutMs = this.options.approvalTimeoutMs ?? 5 * 60_000;
    const approval = await this.store.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      if (!run) notFound("Run");
      const explicitTaskId =
        typeof args.taskId === "string" ? args.taskId : undefined;
      const task =
        state.tasks.find((item) => item.id === explicitTaskId) ??
        state.tasks.find(
          (item) =>
            item.conversationId === run.conversationId &&
            item.status !== "completed" &&
            item.status !== "cancelled" &&
            item.assigneeIds.includes(employeeId)
        );
      const timestamp = now();
      const approval = {
        id: crypto.randomUUID(),
        workspaceId: state.workspace.id,
        runId,
        messageId,
        taskId: task?.id,
        employeeId,
        toolCallId,
        toolName: tool.name,
        args,
        status: "pending" as const,
        createdAt: timestamp,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString()
      };
      state.approvals.push(approval);
      if (task) {
        if (task.status === "draft" || task.status === "review") {
          transitionTask(task, "in_progress", employeeId);
        }
        if (task.status !== "blocked") {
          transitionTask(task, "blocked", employeeId);
        }
      }
      run.status = "waiting_approval";
      appendEvent(state, run, "approval_requested", {
        approvalId: approval.id,
        employeeId,
        toolCallId,
        toolName: tool.name,
        args
      });
      return structuredClone(approval);
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await this.store.read(
        (state) => state.approvals.find((item) => item.id === approval.id) ?? approval
      );
      if (current.status !== "pending") {
        if (
          current.toolCallId &&
          current.toolCallId !== approval.toolCallId
        ) {
          throw new Error("Approval does not match this Tool call");
        }
        await this.store.update((state) => {
          settleApproval(state, runId, current);
        });
        return current;
      }
    }

    return this.store.update((state) => {
      const current = state.approvals.find((item) => item.id === approval.id);
      if (!current) notFound("Approval");
      if (current.status !== "pending") {
        settleApproval(state, runId, current);
        return structuredClone(current);
      }
      current.status = "expired";
      current.resolvedAt = now();
      if (current.taskId) {
        const task = state.tasks.find((item) => item.id === current.taskId);
        if (task && task.status !== "completed" && task.status !== "cancelled") {
          transitionTask(task, "in_progress", "user");
        }
      }
      settleApproval(state, runId, current);
      return structuredClone(current);
    });
  }
}
