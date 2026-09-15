import { describe, expect, it } from "vitest";
import type { ProviderRegistry } from "@/server/application/provider-gateway";
import { WorkspaceService } from "@/server/application/workspace-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import { createInitialState } from "@/server/store/initial-state";

const registry: ProviderRegistry = {
  async validate() {},
  async listModels() {
    return [
      {
        id: "test-model",
        name: "Test Model",
        reasoning: true,
        supportsStructuredOutput: true
      }
    ];
  }
};

function setup() {
  const store = new MemoryStore(
    createInitialState("00000000-0000-4000-8000-000000000001")
  );
  const service = new WorkspaceService(
    store,
    new AesCredentialCipher("skill-test-key"),
    registry
  );
  return { service, store };
}

async function createProvider(service: WorkspaceService) {
  return service.createProvider({
    provider: "openai",
    label: "Primary",
    credential: "secret"
  });
}

describe("Skill configuration", () => {
  it("creates a structured custom Skill with an allowed Tool list", async () => {
    const { service, store } = setup();

    const skill = await service.createSkill({
      name: "Fact checker",
      description: "Checks claims against sources.",
      instructions: "Check each claim and identify uncertainty.",
      inputs: ["draft"],
      outputs: ["review"],
      toolNames: ["fetch_url", "current_time"]
    });

    expect(skill).toMatchObject({
      name: "Fact checker",
      toolNames: ["fetch_url", "current_time"],
      builtIn: false
    });
    expect(store.snapshot().skills).toContainEqual(skill);
  });

  it("rejects unknown Tool references", async () => {
    const { service, store } = setup();

    await expect(
      service.createSkill({
        name: "Unsafe",
        description: "References a missing Tool.",
        instructions: "Use the missing Tool.",
        inputs: [],
        outputs: [],
        toolNames: ["arbitrary_shell"]
      })
    ).rejects.toMatchObject({ code: "invalid_tool" });

    expect(store.snapshot().skills.some((skill) => skill.name === "Unsafe")).toBe(
      false
    );
  });

  it("rejects malformed structured Skill input", async () => {
    const { service, store } = setup();

    await expect(
      service.createSkill({
        name: "",
        description: "Missing required Skill fields.",
        instructions: "",
        inputs: "not-an-array",
        outputs: [],
        toolNames: []
      })
    ).rejects.toThrow();

    expect(
      store.snapshot().skills.some(
        (skill) => skill.description === "Missing required Skill fields."
      )
    ).toBe(false);
  });

  it("rejects executable code and arbitrary scripts", async () => {
    const { service, store } = setup();

    await expect(
      service.createSkill({
        name: "Executable",
        description: "Attempts to ship code.",
        instructions: "Run it.",
        inputs: [],
        outputs: [],
        toolNames: [],
        code: "process.exit(0)",
        script: "rm -rf /"
      })
    ).rejects.toThrow();

    expect(store.snapshot().skills.some((skill) => skill.name === "Executable")).toBe(
      false
    );
  });

  it("rejects shell, host filesystem, and executable entrypoints", async () => {
    const { service, store } = setup();

    await expect(
      service.createSkill({
        name: "Filesystem",
        description: "Attempts host filesystem access.",
        instructions: "Read the host filesystem.",
        inputs: [],
        outputs: [],
        toolNames: ["shell", "read_file"]
      })
    ).rejects.toMatchObject({ code: "invalid_tool" });
    await expect(
      service.createSkill({
        name: "Entrypoint",
        description: "Attempts an executable entrypoint.",
        instructions: "Run the script.",
        inputs: [],
        outputs: [],
        toolNames: [],
        entrypoint: "node"
      })
    ).rejects.toThrow();

    expect(
      store.snapshot().skills.some((skill) =>
        ["Filesystem", "Entrypoint"].includes(skill.name)
      )
    ).toBe(false);
  });

  it("edits custom Skills but protects built-in Skills", async () => {
    const { service } = setup();
    const custom = await service.createSkill({
      name: "Custom",
      description: "Before",
      instructions: "Before instructions.",
      inputs: [],
      outputs: [],
      toolNames: []
    });
    const builtIn = (await service.getWorkspaceView()).skills.find(
      (skill) => skill.builtIn
    )!;

    await expect(
      service.updateSkill(custom.id, {
        name: "Custom edited",
        description: "After",
        instructions: "After instructions.",
        inputs: ["context"],
        outputs: ["result"],
        toolNames: ["current_time"]
      })
    ).resolves.toMatchObject({ name: "Custom edited" });
    await expect(
      service.updateSkill(builtIn.id, {
        name: "Changed",
        description: "Changed",
        instructions: "Changed",
        inputs: [],
        outputs: [],
        toolNames: []
      })
    ).rejects.toMatchObject({ code: "builtin_skill" });
  });

  it("assigns and removes a Skill from an Employee", async () => {
    const { service } = setup();
    const provider = await createProvider(service);
    const skill = await service.createSkill({
      name: "Reusable",
      description: "Can be assigned and removed.",
      instructions: "Do the reusable work.",
      inputs: [],
      outputs: [],
      toolNames: []
    });
    const employee = await service.createEmployee({
      name: "Employee",
      identity: "Employee identity.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      skillIds: [skill.id],
      active: true
    });

    expect(employee.skillIds).toEqual([skill.id]);
    const updated = await service.updateEmployee(employee.id, {
      ...employee,
      skillIds: []
    });
    expect(updated.skillIds).toEqual([]);
  });

  it("reuses built-in Skills across Employees", async () => {
    const { service } = setup();
    const provider = await createProvider(service);
    const builtIn = (await service.getWorkspaceView()).skills.find(
      (skill) => skill.name === "Writer"
    )!;
    const base = {
      identity: "Employee identity.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      skillIds: [builtIn.id],
      active: true
    };

    const first = await service.createEmployee({ ...base, name: "First" });
    const second = await service.createEmployee({ ...base, name: "Second" });

    expect(first.skillIds).toEqual([builtIn.id]);
    expect(second.skillIds).toEqual([builtIn.id]);
  });
});
