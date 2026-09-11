import { describe, expect, it } from "vitest";
import { WorkspaceService } from "@/server/application/workspace-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureState,
  noopProviderRegistry,
  TEST_KEY
} from "@/server/test-support/fixtures";

describe("Workspace Configuration", () => {
  it("moves Tasks through employee review to user completion", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await service.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Write launch brief",
        goal: "Produce a concise launch brief.",
        assigneeIds: ["20000000-0000-4000-8000-000000000002"]
      }
    );

    await service.updateTask(
      task.id,
      { status: "in_progress" },
      "20000000-0000-4000-8000-000000000002"
    );
    await service.updateTask(
      task.id,
      { status: "review" },
      "20000000-0000-4000-8000-000000000002"
    );
    const completed = await service.updateTask(
      task.id,
      { status: "completed" },
      "user"
    );

    expect(completed.status).toBe("completed");
    expect(completed.history.map((entry) => entry.status)).toEqual([
      "draft",
      "in_progress",
      "review",
      "completed"
    ]);
  });

  it("rejects employee completion authority", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await service.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Review evidence",
        goal: "Check all claims.",
        assigneeIds: []
      }
    );

    await expect(
      service.updateTask(task.id, { status: "completed" }, "employee")
    ).rejects.toMatchObject({ status: 403 });
  });

  it("encrypts provider credentials at rest and never returns the secret", async () => {
    const cipher = new AesCredentialCipher(TEST_KEY);
    const state = createFixtureState();
    const encrypted = state.providers[0].encryptedCredential;
    expect(encrypted).not.toContain("test-api-key");
    expect(cipher.decrypt(encrypted)).toBe("test-api-key");

    const providers = await new WorkspaceService(
      new MemoryStore(state),
      cipher,
      noopProviderRegistry
    ).listProviders();
    expect(providers[0]).not.toHaveProperty("encryptedCredential");
  });
});
