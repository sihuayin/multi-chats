import type { AppState, IsoDate, Skill, ToolDefinition, Workspace } from "@/server/domain/types";
import { CURRENT_SCHEMA_VERSION } from "@/server/store/migrations";

export const BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: "current_time",
    label: "Current time",
    description: "Return the current server time.",
    risk: "read",
    requiresApproval: false,
    replay: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {}
    }
  },
  {
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch readable text from an HTTP or HTTPS URL.",
    risk: "read",
    requiresApproval: false,
    replay: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri" }
      }
    }
  },
  {
    name: "post_webhook",
    label: "Post webhook",
    description: "Send a JSON payload to an external HTTP endpoint.",
    risk: "write",
    requiresApproval: true,
    replay: "never",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url", "body"],
      properties: {
        url: { type: "string", format: "uri" },
        body: { type: "object" }
      }
    }
  },
  {
    name: "update_task",
    label: "Update Task",
    description: "Move an assigned Task to in_progress, blocked, or review.",
    risk: "write",
    requiresApproval: false,
    replay: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId", "status"],
      properties: {
        taskId: { type: "string" },
        status: { type: "string", enum: ["in_progress", "blocked", "review"] }
      }
    }
  },
  {
    name: "attach_artifact",
    label: "Attach Artifact",
    description: "Attach a text, Markdown, or JSON result to an assigned Task.",
    risk: "write",
    requiresApproval: false,
    replay: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["taskId", "name", "type", "content"],
      properties: {
        taskId: { type: "string" },
        name: { type: "string" },
        type: { type: "string", enum: ["text", "markdown", "json"] },
        content: { type: "string" }
      }
    }
  }
];

function makeBuiltinSkill(
  workspaceId: string,
  now: IsoDate,
  input: Pick<Skill, "name" | "description" | "instructions" | "inputs" | "outputs" | "toolNames">
): Skill {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    builtIn: true,
    createdAt: now,
    updatedAt: now,
    ...input
  };
}

export function createInitialState(workspaceId = crypto.randomUUID()): AppState {
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: workspaceId,
    name: "My Workspace",
    createdAt: now,
    updatedAt: now
  };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workspace,
    providers: [],
    employees: [],
    skills: [
      makeBuiltinSkill(workspace.id, now, {
        name: "Researcher",
        description: "Collects facts from approved sources.",
        instructions:
          "Research the requested topic. Use only allowed tools and distinguish verified facts from uncertainty.",
        inputs: ["question", "task context"],
        outputs: ["findings", "sources", "uncertainties"],
        toolNames: ["current_time", "fetch_url"]
      }),
      makeBuiltinSkill(workspace.id, now, {
        name: "Writer",
        description: "Turns research and notes into clear prose.",
        instructions:
          "Write clearly for the requested audience. Preserve facts and surface assumptions.",
        inputs: ["brief", "source material"],
        outputs: ["draft"],
        toolNames: []
      }),
      makeBuiltinSkill(workspace.id, now, {
        name: "Reviewer",
        description: "Checks a draft for gaps and contradictions.",
        instructions:
          "Review the supplied work. Prioritize correctness, missing evidence, contradictions, and unclear claims.",
        inputs: ["draft", "requirements"],
        outputs: ["review", "blocking issues"],
        toolNames: []
      })
    ],
    groups: [],
    conversations: [],
    messages: [],
    runs: [],
    runEvents: [],
    tasks: [],
    artifacts: [],
    discussions: [],
    approvals: [],
    idempotencyRecords: []
  };
}
