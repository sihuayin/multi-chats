import { describe, expect, it } from "vitest";
import { WorkspaceService } from "@/server/application/workspace-service";
import { BUILT_IN_TOOLS } from "@/server/store/initial-state";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { MemoryStore } from "@/server/store/memory-store";
import {
  createFixtureDiscussion,
  createFixtureState,
  noopProviderRegistry,
  TEST_KEY
} from "@/server/test-support/fixtures";

describe("Workspace Configuration", () => {
  it("exposes Discussions in the Workspace view", async () => {
    const state = createFixtureState();
    const discussion = createFixtureDiscussion({
      workspaceId: state.workspace.id,
      conversationId: state.conversations[0].id
    });
    state.discussions.push(discussion);
    const service = new WorkspaceService(
      new MemoryStore(state),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );

    expect((await service.getWorkspaceView()).discussions).toEqual([
      discussion
    ]);
  });

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
    expect([
      text.ownerId,
      markdown.ownerId,
      json.ownerId
    ]).toEqual([
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
      ownerType: "task",
      ownerId: task.id,
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

  it("serves the Tool registry from Workspace state", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );

    const view = await service.getWorkspaceView();

    // Same registry the code constant used to supply, now owned by the
    // Workspace and carrying seeded identities.
    expect(view.tools.map((tool) => tool.name)).toEqual(
      BUILT_IN_TOOLS.map((tool) => tool.name)
    );
    expect(view.tools.map((tool) => tool.id)).toEqual(
      BUILT_IN_TOOLS.map((tool) => `builtin:${tool.name}`)
    );
    expect(view.tools.every((tool) => tool.builtIn)).toBe(true);
    expect(view.tools.every((tool) => tool.workspaceId === view.workspace.id)).toBe(true);
  });
});

describe("Tool registry", () => {
  function service() {
    return new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
  }

  const draft = {
    name: "home_status",
    label: "Home Assistant status",
    description: "Read a Home Assistant entity state.",
    risk: "read",
    requiresApproval: false,
    replay: "safe",
    inputSchema: { type: "object", properties: {} },
    request: {
      method: "GET",
      urlTemplate: "http://nas.local:8123/api/states/{entity}"
    },
    credential: "super-secret-token"
  } as const;

  it("rejects a Tool created without an approval decision", async () => {
    const { requiresApproval, ...withoutDecision } = draft;

    await expect(service().createTool(withoutDecision)).rejects.toThrow();
    expect(requiresApproval).toBe(false);
  });

  it("never returns a credential, only whether one is configured", async () => {
    const workspace = service();
    const created = await workspace.createTool(draft);
    const view = await workspace.getWorkspaceView();
    const tool = view.tools.find((item) => item.id === created.id);

    expect(tool?.configured).toBe(true);
    expect(tool).not.toHaveProperty("encryptedCredential");
    expect(JSON.stringify(view)).not.toContain("super-secret-token");
  });

  it("refuses a name a built-in already holds", async () => {
    await expect(
      service().createTool({ ...draft, name: "fetch_url" })
    ).rejects.toThrow(/already exists/);
  });

  it("cannot edit or delete a built-in", async () => {
    const workspace = service();
    const builtIn = (await workspace.getWorkspaceView()).tools.find(
      (tool) => tool.name === "fetch_url"
    );

    await expect(
      workspace.updateTool(builtIn!.id, { ...draft, name: "fetch_url" })
    ).rejects.toThrow(/Built-in Tools cannot be edited/);
    await expect(workspace.deleteTool(builtIn!.id)).rejects.toThrow(
      /Built-in Tools cannot be deleted/
    );
  });

  it("refuses to rename a Tool", async () => {
    const workspace = service();
    const created = await workspace.createTool(draft);

    await expect(
      workspace.updateTool(created.id, { ...draft, name: "other_name" })
    ).rejects.toThrow(/name cannot change/);
  });

  it("refuses to delete a Tool a Skill still allows, and disabling works", async () => {
    const workspace = service();
    const created = await workspace.createTool(draft);
    await workspace.createSkill({
      name: "Home",
      description: "Reads the house.",
      instructions: "Report the entity state.",
      inputs: ["entity"],
      outputs: ["state"],
      toolNames: [created.name]
    });

    await expect(workspace.deleteTool(created.id)).rejects.toThrow(
      /Still allowed by Home/
    );

    const disabled = await workspace.updateTool(created.id, {
      ...draft,
      active: false
    });
    expect(disabled.active).toBe(false);
  });

  it("clears a credential when the operator asks for it", async () => {
    const workspace = service();
    const created = await workspace.createTool(draft);

    const cleared = await workspace.updateTool(created.id, {
      ...draft,
      credential: null
    });

    expect(cleared.configured).toBe(false);
  });

  it("creates a Conversation that is not excluded from retrieval", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );

    const conversation = await service.createConversation({
      title: "Release scope"
    });

    expect(conversation.retrievalExcluded).toBe(false);
  });

  it("excludes a Conversation from retrieval without changing anything else", async () => {
    const store = new MemoryStore(createFixtureState());
    const service = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const created = await service.createConversation({ title: "Scratch notes" });

    const excluded = await service.updateConversation(created.id, {
      retrievalExcluded: true
    });

    expect(excluded.retrievalExcluded).toBe(true);
    await expect(
      store.read((state) =>
        state.conversations.find((item) => item.id === created.id)
      )
    ).resolves.toMatchObject({
      title: created.title,
      memberIds: created.memberIds,
      createdAt: created.createdAt,
      retrievalExcluded: true
    });

    const restored = await service.updateConversation(created.id, {
      retrievalExcluded: false
    });
    expect(restored.retrievalExcluded).toBe(false);
  });

  it("applies both fields of a Conversation patch, dropping neither", async () => {
    const service = new WorkspaceService(
      new MemoryStore(createFixtureState()),
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const created = await service.createConversation({ title: "Both fields" });

    const updated = await service.updateConversation(created.id, {
      memberIds: ["20000000-0000-4000-8000-000000000001"],
      retrievalExcluded: true
    });

    expect(updated.memberIds).toEqual([
      "20000000-0000-4000-8000-000000000001"
    ]);
    expect(updated.retrievalExcluded).toBe(true);
  });
});
