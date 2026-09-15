import { describe, expect, it } from "vitest";
import type {
  ProviderAccess,
  ProviderModelSummary,
  ProviderRegistry
} from "@/server/application/provider-gateway";
import { WorkspaceService } from "@/server/application/workspace-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import { createInitialState } from "@/server/store/initial-state";

class EmployeeProviderRegistry implements ProviderRegistry {
  readonly modelQueries: ProviderAccess[] = [];
  models: ProviderModelSummary[] = [
    {
      id: "test-model",
      name: "Test Model",
      contextWindow: 128_000,
      maxTokens: 8_000,
      reasoning: true,
      supportsStructuredOutput: true
    }
  ];

  async validate() {}

  async listModels(access: ProviderAccess) {
    this.modelQueries.push(access);
    return this.models;
  }
}

function setup() {
  const registry = new EmployeeProviderRegistry();
  const store = new MemoryStore(
    createInitialState("00000000-0000-4000-8000-000000000001")
  );
  const service = new WorkspaceService(
    store,
    new AesCredentialCipher("employee-test-key"),
    registry
  );
  return { registry, service, store };
}

async function createProvider(service: WorkspaceService) {
  return service.createProvider({
    provider: "openai",
    label: "Primary",
    credential: "secret"
  });
}

describe("Employee configuration", () => {
  it("creates an Employee from configured provider catalog metadata", async () => {
    const { service, store, registry } = setup();
    const provider = await createProvider(service);

    const employee = await service.createEmployee({
      name: "Researcher",
      identity: "Research carefully and cite uncertainty.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      skillIds: [],
      active: true
    });

    expect(employee).toMatchObject({
      name: "Researcher",
      providerCredentialId: provider.id,
      modelId: "test-model",
      active: true
    });
    expect(store.snapshot().employees).toHaveLength(1);
    expect(registry.modelQueries).toHaveLength(1);
  });

  it("rejects a model that is absent from the configured provider catalog", async () => {
    const { service, store } = setup();
    const provider = await createProvider(service);

    await expect(
      service.createEmployee({
        name: "Broken",
        identity: "This should not persist.",
        providerCredentialId: provider.id,
        modelId: "missing-model",
        skillIds: [],
        active: true
      })
    ).rejects.toMatchObject({ code: "invalid_model" });

    expect(store.snapshot().employees).toHaveLength(0);
  });

  it("stores an ordered fallback target list", async () => {
    const { service, registry } = setup();
    const provider = await createProvider(service);
    registry.models = [
      ...registry.models,
      {
        id: "fallback-model",
        name: "Fallback Model",
        contextWindow: 64_000,
        maxTokens: 4_000,
        reasoning: false,
        supportsStructuredOutput: true
      }
    ];

    const employee = await service.createEmployee({
      name: "Resilient",
      identity: "Use a secondary model when the primary fails.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      fallbackTargets: [
        {
          providerCredentialId: provider.id,
          modelId: "fallback-model"
        }
      ],
      skillIds: [],
      active: true
    });

    expect(employee.fallbackTargets).toEqual([
      {
        providerCredentialId: provider.id,
        modelId: "fallback-model"
      }
    ]);
  });

  it("rejects duplicate or structured-output-incompatible fallback targets", async () => {
    const { service, registry } = setup();
    const provider = await createProvider(service);

    await expect(
      service.createEmployee({
        name: "Duplicate",
        identity: "This target duplicates the primary.",
        providerCredentialId: provider.id,
        modelId: "test-model",
        fallbackTargets: [
          {
            providerCredentialId: provider.id,
            modelId: "test-model"
          }
        ],
        skillIds: [],
        active: true
      })
    ).rejects.toMatchObject({ code: "invalid_model" });

    registry.models = [
      ...registry.models,
      {
        id: "unsupported-model",
        name: "Unsupported Model",
        contextWindow: 32_000,
        maxTokens: 2_000,
        reasoning: false,
        supportsStructuredOutput: false
      }
    ];
    await expect(
      service.createEmployee({
        name: "Unsupported",
        identity: "This fallback cannot produce structured output.",
        providerCredentialId: provider.id,
        modelId: "test-model",
        fallbackTargets: [
          {
            providerCredentialId: provider.id,
            modelId: "unsupported-model"
          }
        ],
        skillIds: [],
        active: true
      })
    ).rejects.toMatchObject({ code: "invalid_model" });
  });

  it("does not delete a Provider referenced only by a fallback target", async () => {
    const { service, registry } = setup();
    const primary = await createProvider(service);
    const fallbackProvider = await service.createProvider({
      provider: "anthropic",
      label: "Fallback",
      credential: "fallback-secret"
    });
    registry.models = [
      ...registry.models,
      {
        id: "fallback-model",
        name: "Fallback Model",
        contextWindow: 64_000,
        maxTokens: 4_000,
        reasoning: false,
        supportsStructuredOutput: true
      }
    ];
    await service.createEmployee({
      name: "Fallback Owner",
      identity: "Keep the fallback credential in use.",
      providerCredentialId: primary.id,
      modelId: "test-model",
      fallbackTargets: [
        {
          providerCredentialId: fallbackProvider.id,
          modelId: "fallback-model"
        }
      ],
      skillIds: [],
      active: true
    });

    await expect(
      service.deleteProvider(fallbackProvider.id)
    ).rejects.toMatchObject({
      code: "provider_in_use"
    });
  });

  it("keeps disabled Employees in history but blocks new Conversation membership", async () => {
    const { service, store } = setup();
    const provider = await createProvider(service);
    const employee = await service.createEmployee({
      name: "Disabled Employee",
      identity: "Historical Employee.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      skillIds: [],
      active: true
    });

    await service.updateEmployee(employee.id, {
      ...employee,
      active: false
    });

    expect(store.snapshot().employees[0].active).toBe(false);
    await expect(
      service.createConversation({
        title: "New work",
        memberIds: [employee.id]
      })
    ).rejects.toMatchObject({ code: "invalid_employee" });
  });

  it("edits Employee identity, model, Skills, and lifecycle state", async () => {
    const { service } = setup();
    const provider = await createProvider(service);
    const employee = await service.createEmployee({
      name: "Before",
      identity: "Before identity.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      skillIds: [],
      active: true
    });
    const skill = (await service.getWorkspaceView()).skills.find(
      (item) => item.name === "Writer"
    )!;

    const updated = await service.updateEmployee(employee.id, {
      name: "After",
      identity: "After identity.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      skillIds: [skill.id],
      active: true
    });

    expect(updated).toMatchObject({
      name: "After",
      identity: "After identity.",
      skillIds: [skill.id],
      active: true
    });
  });

  it("can disable or edit an Employee after its model leaves the provider catalog", async () => {
    const { service, registry } = setup();
    const provider = await createProvider(service);
    const employee = await service.createEmployee({
      name: "Historical",
      identity: "Keep this history.",
      providerCredentialId: provider.id,
      modelId: "test-model",
      skillIds: [],
      active: true
    });
    registry.models = [];

    const renamed = await service.updateEmployee(employee.id, {
      ...employee,
      name: "Historical Employee",
      active: false
    });

    expect(renamed).toMatchObject({
      name: "Historical Employee",
      modelId: "test-model",
      active: false
    });
  });
});
