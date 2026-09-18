import Ajv, { type ValidateFunction } from "ajv";
import { appendEvent } from "@/server/application/run-ledger";
import {
  assertTaskAssignee,
  transitionTask
} from "@/server/application/task-ledger";
import { createTaskArtifact } from "@/server/application/artifact-ledger";
import { ApiError } from "@/server/application/errors";
import { assertSafeHttpUrl } from "@/server/security/ssrf";
import type {
  AppState,
  Run,
  Task,
  ToolDefinition
} from "@/server/domain/types";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import type { StateStore } from "@/server/store/store";

export const toolExecutionErrorKinds = [
  "unauthorized",
  "validation",
  "cancelled",
  "execution"
] as const;

export type ToolExecutionErrorKind = (typeof toolExecutionErrorKinds)[number];

export function isToolExecutionErrorKind(
  value: unknown
): value is ToolExecutionErrorKind {
  return (
    typeof value === "string" &&
    toolExecutionErrorKinds.includes(value as ToolExecutionErrorKind)
  );
}

export type ToolExecutionContext = {
  runId: string;
  messageId: string;
  employeeId: string;
  allowedToolNames: string[];
};

export type ToolExecutionRequest = {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  context: ToolExecutionContext;
  signal?: AbortSignal;
};

export type ToolExecutionResult = {
  content: string;
  details?: unknown;
  isError?: boolean;
  errorKind?: ToolExecutionErrorKind;
};

export interface ToolGateway {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

function validationMessage(validate: ValidateFunction): string {
  const details = (validate.errors ?? [])
    .map((error) => {
      const path = error.instancePath || "arguments";
      return `${path} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
  return details
    ? `Invalid Tool arguments: ${details}`
    : "Invalid Tool arguments";
}

function findRunTask(
  state: AppState,
  runId: string,
  taskId: string
): { run: Run; task: Task } {
  const run = state.runs.find((item) => item.id === runId);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!run || !task || task.conversationId !== run.conversationId) {
    throw new Error("Task does not belong to this Conversation");
  }
  return { run, task };
}

export class RegisteredToolGateway implements ToolGateway {
  private readonly toolsByName: Map<string, ToolDefinition>;
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly store: StateStore) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addFormat("uri", {
      type: "string",
      validate: (value: string) => {
        try {
          const url = new URL(value);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      }
    });
    this.toolsByName = new Map(
      BUILT_IN_TOOLS.map((tool) => [tool.name, tool])
    );
    for (const tool of BUILT_IN_TOOLS) {
      this.validators.set(tool.name, ajv.compile(tool.inputSchema));
    }
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const definition = this.toolsByName.get(request.tool.name);
    if (
      !definition ||
      !request.context.allowedToolNames.includes(request.tool.name)
    ) {
      return {
        content: `Tool ${request.tool.name} is not authorized for this Employee.`,
        isError: true,
        errorKind: "unauthorized"
      };
    }
    if (request.signal?.aborted) {
      return {
        content: "Tool call cancelled.",
        isError: true,
        errorKind: "cancelled"
      };
    }
    const validate = this.validators.get(definition.name);
    if (!validate) {
      return {
        content: `Tool ${definition.name} has no validator.`,
        isError: true,
        errorKind: "execution"
      };
    }
    if (!validate(request.args)) {
      return {
        content: validationMessage(validate),
        details: { errors: validate.errors },
        isError: true,
        errorKind: "validation"
      };
    }

    try {
      return await this.executeRegistered(
        definition,
        request.args,
        request.context,
        request.signal
      );
    } catch (error) {
      if (request.signal?.aborted) {
        return {
          content: "Tool call cancelled.",
          isError: true,
          errorKind: "cancelled"
        };
      }
      if (error instanceof ApiError && error.code === "invalid_json") {
        return {
          content: error.message,
          isError: true,
          errorKind: "validation"
        };
      }
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
        errorKind: "execution"
      };
    }
  }

  private async executeRegistered(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    signal?: AbortSignal
  ): Promise<ToolExecutionResult> {
    if (tool.name === "current_time") {
      return { content: new Date().toISOString() };
    }

    if (tool.name === "fetch_url") {
      const url = assertSafeHttpUrl(String(args.url));
      const response = await fetch(url, {
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
      const url = assertSafeHttpUrl(String(args.url));
      const response = await fetch(url, {
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
      const taskId = String(args.taskId);
      const status = String(args.status) as "in_progress" | "blocked" | "review";
      await this.store.update((state) => {
        const { run, task } = findRunTask(state, context.runId, taskId);
        transitionTask(task, status, context.employeeId);
        appendEvent(state, run, "task_changed", {
          taskId,
          status: task.status,
          employeeId: context.employeeId,
          messageId: context.messageId
        });
      });
      return { content: `Task moved to ${status}.` };
    }

    if (tool.name === "attach_artifact") {
      const taskId = String(args.taskId);
      const artifactId = await this.store.update((state) => {
        const { run, task } = findRunTask(state, context.runId, taskId);
        assertTaskAssignee(task, context.employeeId);
        const artifact = createTaskArtifact(
          state,
          taskId,
          {
            type: args.type,
            name: args.name,
            content: args.content
          },
          context.employeeId,
          { runId: context.runId }
        );
        appendEvent(state, run, "artifact_created", {
          taskId,
          artifactId: artifact.id,
          employeeId: context.employeeId,
          messageId: context.messageId
        });
        return artifact.id;
      });
      return { content: "Artifact attached.", details: { artifactId } };
    }

    throw new Error(`Tool ${tool.name} is not implemented`);
  }
}
