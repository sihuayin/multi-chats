import type {
  AppState,
  IsoDate,
  Skill,
  ToolDefinition,
  Workspace
} from "@/server/domain/types";
import {
  CURRENT_SCHEMA_VERSION,
  seedBuiltInTools
} from "@/server/store/migrations";

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
    name: "search_sources",
    label: "Search Sources",
    description:
      "Search every ready Source the Workspace has ingested and return citable chunks of the Workspace's own documents. Use it to answer from the Workspace's material rather than general knowledge. Each result carries its citation alias; cite in your reply only the chunks you actually used.",
    risk: "read",
    requiresApproval: false,
    replay: "safe",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "What to search for, in the words the current turn needs."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum chunks to return (default 5)."
        },
        sourceId: {
          type: "string",
          minLength: 1,
          description:
            "Optional single Source to narrow the search to. Not a permission boundary: without it, every ready Source is searched."
        }
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

/**
 * Tools withheld from Discussion Turns by name, regardless of
 * requiresApproval — the one named place a Tool goes when it must stay out
 * of Discussions, and the precedent for the next Tool with the same problem.
 *
 * `search_sources` (#181): a Discussion's evidence is what the user attached
 * to it, and that is a control point. The Chunks this Tool returns are
 * workspace-wide retrieval, not in `discussion.sourceIds`, so its citations
 * would fail the Turn's evidence catalog (ADR-0002). Withheld Tools are
 * silently absent from the Turn — the same precedent as silently dropping
 * inactive Tools — and the Conversation path keeps offering them.
 */
export const DISCUSSION_WITHHELD_TOOL_NAMES: readonly string[] = [
  "search_sources"
];

/**
 * A shipped built-in Skill as pure definition: no id, no Workspace, no
 * timestamps. Definitions are the code authority a later migration compares
 * a Workspace's stored rows against (matched on the built-in flag plus
 * name), so they must stay separable from identity.
 */
export type BuiltInSkillDefinition = Pick<
  Skill,
  "name" | "description" | "instructions" | "inputs" | "outputs" | "toolNames"
>;

export const BUILT_IN_SKILLS: BuiltInSkillDefinition[] = [
  {
    name: "Researcher",
    description: "Collects facts from approved sources.",
    instructions:
      "Research the requested topic. Use only allowed tools and distinguish verified facts from uncertainty.",
    inputs: ["question", "task context"],
    outputs: ["findings", "sources", "uncertainties"],
    toolNames: ["current_time", "fetch_url", "search_sources"]
  },
  {
    name: "Writer",
    description: "Turns research and notes into clear prose.",
    instructions:
      "Write clearly for the requested audience. Preserve facts and surface assumptions.",
    inputs: ["brief", "source material"],
    outputs: ["draft"],
    toolNames: []
  },
  {
    name: "Reviewer",
    description: "Checks a draft for gaps and contradictions.",
    instructions:
      "Review the supplied work. Prioritize correctness, missing evidence, contradictions, and unclear claims.",
    inputs: ["draft", "requirements"],
    outputs: ["review", "blocking issues"],
    toolNames: []
  }
];

/**
 * Project a stored Skill row back to its definitional fields, so a reader
 * can compare it against `BUILT_IN_SKILLS` without instantiating anything
 * or touching a live Workspace.
 */
export function builtInSkillDefinitionOf(
  skill: Skill
): BuiltInSkillDefinition {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    inputs: [...skill.inputs],
    outputs: [...skill.outputs],
    toolNames: [...skill.toolNames]
  };
}

/**
 * Installation, and the only place a built-in Skill identity is minted:
 * a fresh id per Workspace plus timestamps, neither of which the
 * definitions carry. Minting is correct ONLY when creating a Workspace;
 * refreshing a stored built-in must preserve its id, because Employees
 * reference Skills by id — reconcile definitional fields in place instead.
 */
function makeBuiltinSkill(
  workspaceId: string,
  now: IsoDate,
  definition: BuiltInSkillDefinition
): Skill {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    builtIn: true,
    createdAt: now,
    updatedAt: now,
    ...structuredClone(definition)
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
    skills: BUILT_IN_SKILLS.map((definition) =>
      makeBuiltinSkill(workspace.id, now, definition)
    ),
    tools: seedBuiltInTools(workspace.id, now),
    groups: [],
    conversations: [],
    messages: [],
    runs: [],
    runEvents: [],
    tasks: [],
    artifacts: [],
    sources: [],
    chunks: [],
    discussions: [],
    providerAttempts: [],
    evidenceReferences: [],
    discussionCompressions: [],
    discussionInterventions: [],
    discussionContextRevisions: [],
    modelPricing: [],
    approvals: [],
    idempotencyRecords: []
  };
}
