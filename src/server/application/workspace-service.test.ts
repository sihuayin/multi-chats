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
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );

    await expect(
      service.updateTask(task.id, { status: "completed" }, "employee")
    ).rejects.toMatchObject({ status: 403 });
  });

  it("allows only the user to cancel Tasks", async () => {
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
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );

    await expect(
      service.updateTask(
        task.id,
        { status: "cancelled" },
        "20000000-0000-4000-8000-000000000001"
      )
    ).rejects.toMatchObject({ code: "task_cancel" });
    await expect(
      service.updateTask(task.id, { status: "cancelled" }, "user")
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects Task updates from unassigned Employees", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await service.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Assigned to Alice",
        goal: "Complete the task.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );

    await expect(
      service.updateTask(
        task.id,
        { status: "in_progress" },
        "20000000-0000-4000-8000-000000000002"
      )
    ).rejects.toMatchObject({ code: "task_assignee" });
  });

  it("keeps at least one assignee on every Task", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );

    await expect(
      service.createTask("30000000-0000-4000-8000-000000000001", {
        title: "Unassigned Task",
        goal: "This should be rejected.",
        assigneeIds: []
      })
    ).rejects.toThrow("Too small");

    const task = await service.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Assigned Task",
        goal: "Keep the assignee invariant.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    await expect(
      service.updateTask(task.id, { assigneeIds: [] }, "user")
    ).rejects.toThrow("Too small");
  });

  it("persists supported Task Artifacts and their updates", async () => {
    const store = new MemoryStore(createFixtureState());
    const service = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await service.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Publish findings",
        goal: "Attach durable results.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );

    const text = await service.createArtifact(
      task.id,
      {
        type: "text",
        name: "Notes",
        content: "Plain-text findings."
      },
      "user"
    );
    const markdown = await service.createArtifact(
      task.id,
      {
        type: "markdown",
        name: "Brief",
        content: "# Findings\n\n- One\n- Two"
      },
      "user"
    );
    const json = await service.createArtifact(
      task.id,
      {
        type: "json",
        name: "Metrics",
        content: JSON.stringify({ confidence: 0.9 })
      },
      "user"
    );

    expect([text.type, markdown.type, json.type]).toEqual([
      "text",
      "markdown",
      "json"
    ]);
    expect([text.taskId, markdown.taskId, json.taskId]).toEqual([
      task.id,
      task.id,
      task.id
    ]);

    const updated = await service.updateArtifact(
      task.id,
      markdown.id,
      {
        name: "Updated brief",
        content: "# Updated findings"
      },
      "user"
    );
    expect(updated).toMatchObject({
      id: markdown.id,
      taskId: task.id,
      name: "Updated brief",
      content: "# Updated findings",
      type: "markdown"
    });

    const persisted = await store.read((state) => ({
      artifacts: state.artifacts,
      actions:
        state.tasks
          .find((item) => item.id === task.id)
          ?.history.filter((entry) => entry.action?.startsWith("artifact_"))
          .map((entry) => entry.action) ?? []
    }));
    expect(persisted.artifacts).toHaveLength(3);
    expect(persisted.actions).toEqual([
      "artifact_created",
      "artifact_created",
      "artifact_created",
      "artifact_updated"
    ]);
  });

  it("rejects invalid, binary, and unsupported Task Artifacts", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await service.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Validate results",
        goal: "Reject unsafe payloads.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );

    await expect(
      service.createArtifact(
        task.id,
        {
          type: "json",
          name: "Broken JSON",
          content: "{"
        },
        "user"
      )
    ).rejects.toMatchObject({ code: "invalid_json" });
    await expect(
      service.createArtifact(
        task.id,
        {
          type: "binary",
          name: "Binary",
          content: "AAECAw=="
        },
        "user"
      )
    ).rejects.toThrow("Invalid option");
    await expect(
      service.createArtifact(
        task.id,
        {
          type: "text",
          name: "Binary body",
          content: { bytes: [0, 1, 2, 3] }
        },
        "user"
      )
    ).rejects.toThrow("Invalid input");
  });

  it("resolves only the selected pending Approval", async () => {
    const state = createFixtureState();
    const now = new Date().toISOString();
    state.approvals.push(
      {
        id: "approval-one",
        workspaceId: state.workspace.id,
        runId: "run-one",
        employeeId: "20000000-0000-4000-8000-000000000001",
        toolCallId: "tool-call-one",
        toolName: "post_webhook",
        args: {},
        status: "pending",
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      {
        id: "approval-two",
        workspaceId: state.workspace.id,
        runId: "run-two",
        employeeId: "20000000-0000-4000-8000-000000000001",
        toolCallId: "tool-call-two",
        toolName: "post_webhook",
        args: {},
        status: "pending",
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    );
    const store = new MemoryStore(state);
    const service = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );

    await service.resolveApproval("approval-one", "approved");

    expect(
      await store.read((current) =>
        current.approvals
          .filter((approval) => approval.id.startsWith("approval-"))
          .map((approval) => [approval.id, approval.status])
      )
    ).toEqual([
      ["approval-one", "approved"],
      ["approval-two", "pending"]
    ]);
  });

  it("expires an Approval before applying a late decision", async () => {
    for (const decision of ["approved", "rejected", "cancelled"] as const) {
      const state = createFixtureState();
      state.approvals.push({
        id: `expired-${decision}`,
        workspaceId: state.workspace.id,
        runId: `run-expired-${decision}`,
        employeeId: "20000000-0000-4000-8000-000000000001",
        toolCallId: `tool-call-expired-${decision}`,
        toolName: "post_webhook",
        args: {},
        status: "pending",
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 1_000).toISOString()
      });
      const store = new MemoryStore(state);
      const service = new WorkspaceService(
        store,
        new AesCredentialCipher(TEST_KEY),
        noopProviderRegistry
      );

      await expect(
        service.resolveApproval(`expired-${decision}`, decision)
      ).resolves.toMatchObject({ status: "expired" });
      expect(
        await store.read((current) =>
          current.approvals.find((item) => item.id === `expired-${decision}`)
        )
      ).toMatchObject({ status: "expired" });
    }
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
