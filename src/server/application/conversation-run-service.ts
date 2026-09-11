import { isIP } from "node:net";

import type {
  AppState,
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
import { transitionTask } from "@/server/application/task-ledger";
import { messageInputSchema } from "@/server/domain/schemas";
import type { CredentialCipher } from "@/server/security/credential-cipher";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import type { StateStore } from "@/server/store/store";

export type StartTurnResult = {
  message: Message;
  run: Run | null;
};

function now(): string {
  return new Date().toISOString();
}

function assertSafeHttpUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "::1"
  ) {
    throw new Error("Local network URLs are not allowed");
  }

  const version = isIP(hostname);
  if (version === 4) {
    const [first, second] = hostname.split(".").map(Number);
    if (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      throw new Error("Private network URLs are not allowed");
    }
  }

  if (
    version === 6 &&
    (hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80"))
  ) {
    throw new Error("Private network URLs are not allowed");
  }

  return url;
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

function appendEvent(
  state: AppState,
  run: Run,
  type: RunEvent["type"],
  payload: Record<string, unknown> = {}
): RunEvent {
  const event: RunEvent = {
    id: crypto.randomUUID(),
    workspaceId: state.workspace.id,
    runId: run.id,
    sequence:
      state.runEvents
        .filter((item) => item.runId === run.id)
        .reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1,
    type,
    payload,
    createdAt: now()
  };
  state.runEvents.push(event);
  return event;
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
        `Task ${task.title} [${task.status}]: ${task.goal}${
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

export class ConversationRunService {
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly store: StateStore,
    private readonly cipher: CredentialCipher,
    private readonly gateway: ModelGateway,
    private readonly options: { approvalTimeoutMs?: number } = {}
  ) {}

  async recoverInterruptedRuns(): Promise<void> {
    await this.store.update((state) => {
      for (const run of state.runs) {
        if (run.status === "running" || run.status === "waiting_approval") {
          run.status = "interrupted";
          run.error = "Worker restarted while the Run was active";
          run.completedAt = now();
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
    this.activeControllers.get(runId)?.abort();
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
        }
      }
      run.status = "cancelled";
      run.completedAt = timestamp;
      appendEvent(state, run, "run_cancelled", {});
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

    const modelTools: ModelTool[] = context.tools.map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      inputSchema: tool.inputSchema,
      replay: tool.replay,
      execute: (toolCallId, args, toolSignal) =>
        this.executeTool(
          runId,
          message.id,
          employeeId,
          tool,
          args,
          toolSignal
        )
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
            throw new Error(event.message);
          }
        }
        completed = true;
      } catch (error) {
        if (attempt >= 2 || producedOutput) throw error;
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
      }
      if (event.type === "error") {
        appendEvent(state, run, "run_error", {
          messageId,
          message: event.message
        });
      }
    });
  }

  private async executeTool(
    runId: string,
    messageId: string,
    employeeId: string,
    tool: ToolDefinition,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ content: string; details?: unknown; isError?: boolean }> {
    if (tool.requiresApproval) {
      const approval = await this.requestApproval(
        runId,
        messageId,
        employeeId,
        tool,
        args
      );
      if (approval.status === "rejected") {
        return {
          content: "The user rejected this Tool call.",
          details: { approvalId: approval.id },
          isError: true
        };
      }
      if (approval.status === "cancelled" || approval.status === "expired") {
        return {
          content: `Tool approval ${approval.status}.`,
          details: { approvalId: approval.id },
          isError: true
        };
      }
    }

    if (tool.name === "current_time") {
      return { content: new Date().toISOString() };
    }

    if (tool.name === "fetch_url") {
      const url = String(args.url ?? "");
      const parsed = assertSafeHttpUrl(url);
      const response = await fetch(parsed, {
        signal,
        headers: { "user-agent": "multi-chats/0.1" }
      });
      const text = (await response.text()).slice(0, 50_000);
      return {
        content: text,
        details: { status: response.status, url }
      };
    }

    if (tool.name === "post_webhook") {
      const url = String(args.url ?? "");
      const parsed = assertSafeHttpUrl(url);
      const response = await fetch(parsed, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "user-agent": "multi-chats/0.1"
        },
        body: JSON.stringify(args.body ?? {})
      });
      return {
        content: `Webhook responded with HTTP ${response.status}.`,
        details: { status: response.status, url }
      };
    }

    if (tool.name === "update_task") {
      const taskId = String(args.taskId ?? "");
      const status = String(args.status ?? "");
      if (!["in_progress", "blocked", "review"].includes(status)) {
        throw new Error("Task status is not allowed for Employee updates");
      }
      await this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        const task = state.tasks.find((item) => item.id === taskId);
        if (!run || !task || task.conversationId !== run.conversationId) {
          throw new Error("Task does not belong to this Conversation");
        }
        if (task.assigneeIds.length > 0 && !task.assigneeIds.includes(employeeId)) {
          throw new Error("Task is not assigned to this Employee");
        }
        transitionTask(
          task,
          status as "in_progress" | "blocked" | "review",
          employeeId
        );
        appendEvent(state, run, "task_changed", {
          taskId,
          status: task.status,
          employeeId
        });
      });
      return { content: `Task moved to ${status}.` };
    }

    if (tool.name === "attach_artifact") {
      const taskId = String(args.taskId ?? "");
      const type = String(args.type ?? "");
      const name = String(args.name ?? "");
      const content = String(args.content ?? "");
      if (!["text", "markdown", "json"].includes(type)) {
        throw new Error("Unsupported Artifact type");
      }
      if (type === "json") JSON.parse(content);
      const artifactId = await this.store.update((state) => {
        const run = state.runs.find((item) => item.id === runId);
        const task = state.tasks.find((item) => item.id === taskId);
        if (!run || !task || task.conversationId !== run.conversationId) {
          throw new Error("Task does not belong to this Conversation");
        }
        if (task.assigneeIds.length > 0 && !task.assigneeIds.includes(employeeId)) {
          throw new Error("Task is not assigned to this Employee");
        }
        const timestamp = now();
        const artifact = {
          id: crypto.randomUUID(),
          workspaceId: state.workspace.id,
          taskId,
          type: type as "text" | "markdown" | "json",
          name,
          content,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        state.artifacts.push(artifact);
        appendEvent(state, run, "artifact_created", {
          taskId,
          artifactId: artifact.id,
          employeeId
        });
        return artifact.id;
      });
      return { content: `Artifact attached.`, details: { artifactId } };
    }

    throw new Error(`Tool ${tool.name} is not implemented`);
  }

  private async requestApproval(
    runId: string,
    messageId: string,
    employeeId: string,
    tool: ToolDefinition,
    args: Record<string, unknown>
  ) {
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
        toolName: tool.name,
        args,
        status: "pending" as const,
        createdAt: timestamp
      };
      state.approvals.push(approval);
      if (task) {
        transitionTask(task, "blocked", employeeId);
      }
      run.status = "waiting_approval";
      appendEvent(state, run, "approval_requested", {
        approvalId: approval.id,
        toolName: tool.name,
        args
      });
      return structuredClone(approval);
    });

    const timeoutMs = this.options.approvalTimeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await this.store.read(
        (state) => state.approvals.find((item) => item.id === approval.id) ?? approval
      );
      if (current.status !== "pending") {
        await this.store.update((state) => {
          const run = state.runs.find((item) => item.id === runId);
          if (!run) return;
          run.status = "running";
          appendEvent(state, run, "approval_resolved", {
            approvalId: current.id,
            status: current.status
          });
        });
        return current;
      }
    }

    return this.store.update((state) => {
      const current = state.approvals.find((item) => item.id === approval.id);
      if (!current) notFound("Approval");
      current.status = "expired";
      current.resolvedAt = now();
      const run = state.runs.find((item) => item.id === runId);
      if (run) {
        run.status = "running";
        appendEvent(state, run, "approval_resolved", {
          approvalId: current.id,
          status: current.status
        });
      }
      return structuredClone(current);
    });
  }
}
