import { describe, expect, it } from "vitest";
import { WorkspaceService } from "@/server/application/workspace-service";
import type { ProviderRegistry } from "@/server/adapters/model/provider-registry";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import { createInitialState } from "@/server/store/initial-state";

class FakeProviderRegistry implements ProviderRegistry {
  readonly validations: string[] = [];

  async validateCredential(
    _provider: "openai",
    credential: string
  ): Promise<void> {
    this.validations.push(credential);
    if (credential === "invalid") {
      throw new Error("Provider credential validation failed: invalid key");
    }
  }

  async listModels() {
    return [
      {
        id: "gpt-test",
        name: "GPT Test",
        contextWindow: 128_000,
        maxTokens: 8_000,
        reasoning: true
      }
    ];
  }
}

function createService() {
  const store = new MemoryStore(
    createInitialState("00000000-0000-4000-8000-000000000001")
  );
  const cipher = new AesCredentialCipher("provider-test-key");
  const registry = new FakeProviderRegistry();
  return {
    store,
    cipher,
    registry,
    service: new WorkspaceService(store, cipher, registry)
  };
}

describe("provider configuration", () => {
  it("encrypts credentials and never exposes them through the read model", async () => {
    const { service, store } = createService();
    const created = await service.createProvider({
      provider: "openai",
      label: "Primary",
      credential: "secret-key"
    });

    expect(created).not.toHaveProperty("encryptedCredential");
    const persisted = store.snapshot().providers[0];
    expect(persisted.encryptedCredential).not.toContain("secret-key");
    expect(
      (await service.getWorkspaceView()).providers[0]
    ).not.toHaveProperty("encryptedCredential");
  });

  it("rejects invalid provider credentials without persisting them", async () => {
    const { service, store } = createService();

    await expect(
      service.createProvider({
        provider: "openai",
        label: "Broken",
        credential: "invalid"
      })
    ).rejects.toThrow("invalid key");

    expect(store.snapshot().providers).toHaveLength(0);
  });

  it("rotates an existing credential and validates the replacement", async () => {
    const { service, store, cipher, registry } = createService();
    const created = await service.createProvider({
      provider: "openai",
      label: "Primary",
      credential: "first-key"
    });

    await service.updateProvider(created.id, {
      provider: "openai",
      label: "Rotated",
      credential: "second-key"
    });

    const persisted = store.snapshot().providers[0];
    expect(persisted.label).toBe("Rotated");
    expect(cipher.decrypt(persisted.encryptedCredential)).toBe("second-key");
    expect(registry.validations).toEqual(["first-key", "second-key"]);
  });

  it("deletes an unused provider", async () => {
    const { service, store } = createService();
    const created = await service.createProvider({
      provider: "openai",
      label: "Primary",
      credential: "secret-key"
    });

    await service.deleteProvider(created.id);

    expect(store.snapshot().providers).toHaveLength(0);
  });

  it("returns model catalog metadata through the provider boundary", async () => {
    const { service, registry } = createService();
    const created = await service.createProvider({
      provider: "openai",
      label: "Primary",
      credential: "secret-key"
    });

    await expect(service.listProviderModels(created.id)).resolves.toEqual([
      {
        id: "gpt-test",
        name: "GPT Test",
        contextWindow: 128_000,
        maxTokens: 8_000,
        reasoning: true
      }
    ]);
    expect(registry.validations).toEqual(["secret-key"]);
  });
});
