import { describe, expect, it } from "vitest";
import * as initialStateModule from "@/server/store/initial-state";
import {
  BUILT_IN_SKILLS,
  BUILT_IN_TOOLS,
  builtInSkillDefinitionOf,
  createInitialState
} from "@/server/store/initial-state";

describe("built-in Skill definitions", () => {
  it("ships the same Skills a Workspace gets today, field for field", () => {
    expect(BUILT_IN_SKILLS).toEqual([
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
    ]);
  });

  it("carries no identity, Workspace, or timestamps", () => {
    for (const definition of BUILT_IN_SKILLS) {
      expect(Object.keys(definition).sort()).toEqual([
        "description",
        "inputs",
        "instructions",
        "name",
        "outputs",
        "toolNames"
      ]);
    }
  });

  it("installs each definition with a fresh identity and stamped timestamps", () => {
    const workspaceId = "10000000-0000-4000-8000-000000000001";
    const state = createInitialState(workspaceId);

    expect(state.skills).toHaveLength(BUILT_IN_SKILLS.length);
    state.skills.forEach((skill, index) => {
      expect(builtInSkillDefinitionOf(skill)).toEqual(
        BUILT_IN_SKILLS[index]
      );
      expect(skill.builtIn).toBe(true);
      expect(skill.workspaceId).toBe(workspaceId);
      expect(skill.id).toBeTruthy();
      expect(skill.createdAt).toBe(skill.updatedAt);
    });
    const ids = new Set(state.skills.map((skill) => skill.id));
    expect(ids.size).toBe(state.skills.length);

    // A second Workspace gets fresh identities over identical definitions.
    const other = createInitialState();
    expect(other.skills.map((skill) => skill.id)).not.toEqual(
      state.skills.map((skill) => skill.id)
    );
    expect(other.skills.map(builtInSkillDefinitionOf)).toEqual(
      state.skills.map(builtInSkillDefinitionOf)
    );
  });

  it("keeps installed rows independent of the shipped definitions", () => {
    const state = createInitialState();
    state.skills[0].toolNames.push("mutated");
    state.skills[0].instructions = "rewritten";
    expect(BUILT_IN_SKILLS[0].toolNames).toEqual([
      "current_time",
      "fetch_url",
      "search_sources"
    ]);
    expect(BUILT_IN_SKILLS[0].instructions).toContain(
      "Research the requested topic."
    );
  });

  it("ships search_sources as a read-only, approval-free, replay-safe built-in", () => {
    const tool = BUILT_IN_TOOLS.find(
      (item) => item.name === "search_sources"
    );
    expect(tool).toMatchObject({
      risk: "read",
      requiresApproval: false,
      replay: "safe"
    });
    const schema = tool!.inputSchema as {
      required: string[];
      properties: Record<string, { minimum?: number; maximum?: number }>;
    };
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.limit).toMatchObject({
      minimum: 1,
      maximum: 20
    });
    expect(schema.properties.sourceId).toBeDefined();
  });

  it("exposes no path that installs a built-in Skill by new identity", () => {
    // Installation happens inside createInitialState only: a refresh of a
    // stored built-in must preserve its id (Employees reference Skills by
    // id), so no single-Skill installer may be exported.
    expect(Object.keys(initialStateModule).sort()).toEqual([
      "BUILT_IN_SKILLS",
      "BUILT_IN_TOOLS",
      "DISCUSSION_WITHHELD_TOOL_NAMES",
      "builtInSkillDefinitionOf",
      "createInitialState"
    ]);
  });
});
