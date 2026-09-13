import { describe, expect, it } from "vitest";
import {
  ConversationRunService,
  parseMentions
} from "@/server/application/conversation-run-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import {
  createFixtureState,
  noopProviderRegistry,
  RecordingModelGateway,
  TEST_KEY,
  ToolCallingModelGateway
} from "@/server/test-support/fixtures";
import { MemoryStore } from "@/server/store/memory-store";
import { WorkspaceService } from "@/server/application/workspace-service";
import type { ModelGateway } from "@/server/application/model-gateway";
import type {
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolGateway
} from "@/server/application/tool-gateway";
import type { AppState, Approval } from "@/server/domain/types";

describe("ConversationRun", () => {
  it("stores a Message without starting a Run when no Employee is mentioned", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const result = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "This is a note for everyone." }
    );

    expect(result.run).toBeNull();
    expect(result.message.status).toBe("complete");
    expect(engine.requests).toHaveLength(0);
  });

  it("keeps at most one active Run per Conversation", async () => {
    const store = new MemoryStoreFixture();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice first run" },
      { requestId: "request-one" }
    );
    expect(started.run?.requestId).toBe("request-one");

    await expect(
      runService.startTurn("30000000-0000-4000-8000-000000000001", {
        content: "@alice second run"
      })
    ).rejects.toMatchObject({ code: "active_run" });

    await runService.cancelRun(started.run!.id);
  });

  it("streams and persists a single Employee response", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway(() => ["Hello", " from Alice"]);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice summarize the launch risks" }
    );
    expect(started.run?.memberSnapshot).toEqual([
      "20000000-0000-4000-8000-000000000001"
    ]);

    const completed = await runService.processRun(started.run!.id);
    expect(completed.error).toBeUndefined();
    expect(completed.status).toBe("completed");
    expect(engine.requests[0]).toMatchObject({
      provider: "openai",
      credential: "test-api-key",
      modelId: "test-model"
    });

    const messages = await runService.listMessages(started.message.conversationId);
    expect(messages.at(-1)).toMatchObject({
      authorType: "employee",
      authorId: "20000000-0000-4000-8000-000000000001",
      content: "Hello from Alice",
      status: "complete"
    });

    const events = await runService.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "employee_turn_started",
      "skill_loaded",
      "message_delta",
      "message_delta",
      "message_completed",
      "employee_turn_completed",
      "run_completed"
    ]);
  });

  it("exposes only Tools allowed by the Employee's Skills", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const alice = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice inspect the Tools" }
    );
    await runService.processRun(alice.run!.id);
    const bob = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@bob inspect the Tools" }
    );
    await runService.processRun(bob.run!.id);

    expect(engine.requests[0].tools.map((tool) => tool.name)).toEqual([
      "current_time",
      "fetch_url"
    ]);
    expect(engine.requests[1].tools).toEqual([]);
  });

  it("executes read-only Tools through the Tool Gateway and uses the result", async () => {
    const store = new MemoryStoreFixture();
    const calls: ToolExecutionRequest[] = [];
    const toolGateway: ToolGateway = {
      async execute(request) {
        calls.push(request);
        return {
          content: "2026-01-01T00:00:00.000Z",
          details: { source: "fake" }
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("current_time", {}, (content) => content),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice use the current time Tool" }
    );

    await runs.processRun(started.run!.id);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      tool: { name: "current_time" },
      args: {},
      context: {
        employeeId: "20000000-0000-4000-8000-000000000001",
        allowedToolNames: ["current_time", "fetch_url"]
      }
    });
    const messages = await runs.listMessages(started.message.conversationId);
    expect(messages.at(-1)?.content).toBe(
      "The Tool returned 2026-01-01T00:00:00.000Z."
    );
    const events = await runs.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool_started", "tool_completed"])
    );
    expect(events.map((event) => event.type)).not.toContain("tool_error");
    expect(await store.read((state) => state.approvals)).toEqual([]);
  });

  it("reports denied Tool calls without executing them", async () => {
    const store = new MemoryStoreFixture();
    const toolGateway: ToolGateway = {
      async execute() {
        return {
          content: "This Tool is not allowed for this Employee.",
          isError: true,
          errorKind: "unauthorized"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("current_time", {}, () => "denied"),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice use a denied Tool" }
    );

    await runs.processRun(started.run!.id);

    const events = await runs.listRunEvents(started.run!.id);
    expect(
      events.find((event) => event.type === "tool_completed")?.payload
    ).toMatchObject({ isError: true, errorKind: "unauthorized" });
    expect(
      events.find((event) => event.type === "tool_error")?.payload
    ).toMatchObject({ errorKind: "unauthorized" });
  });

  it("reports Tool schema failures without executing the Tool", async () => {
    const store = new MemoryStoreFixture();
    const toolGateway: ToolGateway = {
      async execute() {
        return {
          content: "Invalid Tool arguments.",
          isError: true,
          errorKind: "validation"
        };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("fetch_url", {}, () => "invalid"),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice call fetch_url without a URL" }
    );

    await runs.processRun(started.run!.id);

    const events = await runs.listRunEvents(started.run!.id);
    expect(
      events.find((event) => event.type === "tool_error")?.payload
    ).toMatchObject({ errorKind: "validation" });
  });

  it("records Tool cancellation separately from completion", async () => {
    const store = new MemoryStoreFixture();
    const toolGateway: ToolGateway = {
      execute(request) {
        return new Promise<ToolExecutionResult>((resolve) => {
          if (request.signal?.aborted) {
            resolve({
              content: "Tool call cancelled.",
              isError: true,
              errorKind: "cancelled"
            });
            return;
          }
          request.signal?.addEventListener(
            "abort",
            () =>
              resolve({
                content: "Tool call cancelled.",
                isError: true,
                errorKind: "cancelled"
              }),
            { once: true }
          );
        });
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      toolModelGateway("current_time", {}, () => "cancelled"),
      { toolGateway }
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice wait inside a Tool" }
    );
    const processing = runs.processRun(started.run!.id);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const startedTool = await store.read((state) =>
        state.runEvents.some(
          (event) =>
            event.runId === started.run!.id && event.type === "tool_started"
        )
      );
      if (startedTool) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await runs.cancelRun(started.run!.id);
    await processing;

    expect((await runs.getRunById(started.run!.id))?.status).toBe("cancelled");
    expect(
      (await runs.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "tool_started",
        "tool_completed",
        "tool_cancelled"
      ])
    );
  });

  it("retries a transient model failure when no output was produced", async () => {
    const store = new MemoryStoreFixture();
    let attempts = 0;
    const gateway: ModelGateway = {
      async *run() {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: "error",
            message: "temporary model failure",
            kind: "retryable"
          };
          return;
        }
        yield { type: "text_delta", delta: "recovered" };
        yield { type: "text_completed", text: "recovered" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice retry this" }
    );

    const completed = await runService.processRun(started.run!.id);

    expect(completed.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(
      (await runService.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toContain("model_error");
  });

  it("keeps partial output when a model fails after streaming starts", async () => {
    const store = new MemoryStoreFixture();
    const gateway: ModelGateway = {
      async *run() {
        yield { type: "text_delta", delta: "partial output" };
        yield {
          type: "error",
          message: "model failed after output",
          kind: "terminal"
        };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice fail after output" }
    );

    const failed = await runService.processRun(started.run!.id);
    const messages = await runService.listMessages(started.message.conversationId);

    expect(failed.status).toBe("failed");
    expect(messages.at(-1)).toMatchObject({
      content: "partial output",
      status: "failed"
    });
    expect(
      (await runService.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "employee_turn_partial",
        "model_error",
        "run_error"
      ])
    );
  });

  it("executes @all members sequentially and gives later members earlier responses", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway(() => ["response"]);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@all draft the launch brief" }
    );
    await runService.processRun(started.run!.id);

    expect(engine.requests).toHaveLength(2);
    expect(engine.requests[0].systemPrompt).toContain("You are Alice");
    expect(engine.requests[1].systemPrompt).toContain("You are Bob");
    expect(engine.requests[1].prompt).toContain("Alice: response");
  });

  it("keeps the @all member snapshot when the Conversation changes mid-Run", async () => {
    const store = new MemoryStoreFixture();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const requests: import("@/server/application/model-gateway").ModelRequest[] =
      [];
    const gateway: ModelGateway = {
      async *run(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "text_delta", delta: "Alice response" };
          yield { type: "text_completed", text: "Alice response" };
          await firstGate;
        } else {
          yield { type: "text_delta", delta: "Bob response" };
          yield { type: "text_completed", text: "Bob response" };
        }
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@all work together" }
    );
    const processing = runService.processRun(started.run!.id);
    for (let attempt = 0; attempt < 20 && requests.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await workspace.updateConversationMembers(
      "30000000-0000-4000-8000-000000000001",
      ["20000000-0000-4000-8000-000000000001"]
    );
    expect(
      await store.read(
        (state) =>
          state.conversations.find(
            (conversation) =>
              conversation.id === "30000000-0000-4000-8000-000000000001"
          )?.memberIds
      )
    ).toEqual(["20000000-0000-4000-8000-000000000001"]);
    releaseFirst?.();
    await processing;

    expect(requests).toHaveLength(2);
    expect(requests[1].systemPrompt).toContain("You are Bob");
    expect(requests[1].prompt).toContain("Alice: Alice response");
  });

  it("lets an assigned Employee move a Task and includes Task context", async () => {
    const state = createFixtureState();
    const skillId = "40000000-0000-4000-8000-000000000003";
    state.skills.push({
      id: skillId,
      workspaceId: state.workspace.id,
      name: "Task worker",
      description: "Updates assigned Tasks.",
      instructions: "Update the assigned Task when work starts.",
      inputs: ["task"],
      outputs: ["status"],
      toolNames: ["update_task"],
      builtIn: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.employees[0].skillIds.push(skillId);
    const store = new MemoryStore(state);
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Implement Task flow",
        goal: "Move the Task to in progress.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const captured: import("@/server/application/model-gateway").ModelRequest[] =
      [];
    const gateway: ModelGateway = {
      async *run(request) {
        captured.push(request);
        const tool = request.tools.find((item) => item.name === "update_task");
        if (!tool) throw new Error("update_task Tool was not available");
        for (const status of ["in_progress", "blocked", "review"]) {
          await tool.execute("tool-call", {
            taskId: task.id,
            status
          });
        }
        yield { type: "text_delta", delta: "Task started." };
        yield { type: "text_completed", text: "Task started." };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice start the assigned Task" }
    );

    await runs.processRun(started.run!.id);

    const updated = await store.read((current) =>
      current.tasks.find((item) => item.id === task.id)
    );
    expect(updated?.status).toBe("review");
    expect(updated?.history.map((entry) => entry.status)).toEqual([
      "draft",
      "in_progress",
      "blocked",
      "review"
    ]);
    expect(updated?.history.at(-1)?.actorId).toBe(
      "20000000-0000-4000-8000-000000000001"
    );
    expect(captured[0].prompt).toContain(task.id);
    expect(captured[0].prompt).toContain("Implement Task flow");
    expect(captured[0].prompt).toContain("Move the Task to in progress.");

    const employeeTool = captured[0].tools.find(
      (item) => item.name === "update_task"
    );
    if (!employeeTool) throw new Error("update_task Tool was not available");
    await expect(
      employeeTool.execute("tool-call", {
        taskId: task.id,
        status: "completed"
      })
    ).resolves.toMatchObject({
      isError: true,
      errorKind: "validation"
    });
    await expect(
      employeeTool.execute("tool-call", {
        taskId: task.id,
        status: "cancelled"
      })
    ).resolves.toMatchObject({
      isError: true,
      errorKind: "validation"
    });
    expect(
      (await store.read((current) =>
        current.tasks.find((item) => item.id === task.id)
      ))?.status
    ).toBe("review");
  });

  it("lets an assigned Employee publish supported Task Artifacts", async () => {
    const state = createFixtureState();
    const skillId = "40000000-0000-4000-8000-000000000004";
    state.skills.push({
      id: skillId,
      workspaceId: state.workspace.id,
      name: "Artifact publisher",
      description: "Publishes structured Task results.",
      instructions: "Attach each requested result to the assigned Task.",
      inputs: ["result"],
      outputs: ["artifact"],
      toolNames: ["attach_artifact"],
      builtIn: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.employees[0].skillIds.push(skillId);
    const store = new MemoryStore(state);
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Publish Task results",
        goal: "Attach all supported result types.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const gateway: ModelGateway = {
      async *run(request) {
        const tool = request.tools.find(
          (item) => item.name === "attach_artifact"
        );
        if (!tool) throw new Error("attach_artifact Tool was not available");
        for (const [type, name, content] of [
          ["text", "Notes", "Plain findings."],
          ["markdown", "Brief", "# Findings"],
          ["json", "Metrics", JSON.stringify({ confidence: 0.9 })]
        ]) {
          await tool.execute(`tool-${type}`, {
            taskId: task.id,
            type,
            name,
            content
          });
        }
        yield { type: "text_delta", delta: "Artifacts published." };
        yield { type: "text_completed", text: "Artifacts published." };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice publish the results" }
    );

    await runs.processRun(started.run!.id);

    const persisted = await store.read((current) => ({
      artifacts: current.artifacts.map((artifact) => ({
        type: artifact.type,
        name: artifact.name,
        ownerType: artifact.ownerType,
        ownerId: artifact.ownerId
      })),
      actions:
        current.tasks
          .find((item) => item.id === task.id)
          ?.history.filter((entry) => entry.action === "artifact_created")
          .map((entry) => entry.actorId) ?? []
    }));
    expect(persisted.artifacts).toEqual([
      {
        type: "text",
        name: "Notes",
        ownerType: "task",
        ownerId: task.id
      },
      {
        type: "markdown",
        name: "Brief",
        ownerType: "task",
        ownerId: task.id
      },
      {
        type: "json",
        name: "Metrics",
        ownerType: "task",
        ownerId: task.id
      }
    ]);
    expect(persisted.actions).toEqual([
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000001"
    ]);
    expect(
      (await runs.listRunEvents(started.run!.id)).filter(
        (event) => event.type === "artifact_created"
      )
    ).toHaveLength(3);
  });

  it("rejects invalid Employee Task Artifacts", async () => {
    const state = createFixtureState();
    const skillId = "40000000-0000-4000-8000-000000000005";
    state.skills.push({
      id: skillId,
      workspaceId: state.workspace.id,
      name: "Artifact publisher",
      description: "Publishes structured Task results.",
      instructions: "Attach requested results to the assigned Task.",
      inputs: ["result"],
      outputs: ["artifact"],
      toolNames: ["attach_artifact"],
      builtIn: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.employees[0].skillIds.push(skillId);
    const store = new MemoryStore(state);
    const workspace = new WorkspaceService(
      store,
      new AesCredentialCipher(TEST_KEY),
      noopProviderRegistry
    );
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Validate Task results",
        goal: "Reject invalid result payloads.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const failures: ToolExecutionResult[] = [];
    const gateway: ModelGateway = {
      async *run(request) {
        const tool = request.tools.find(
          (item) => item.name === "attach_artifact"
        );
        if (!tool) throw new Error("attach_artifact Tool was not available");
        for (const args of [
          {
            taskId: task.id,
            type: "binary",
            name: "Binary",
            content: "AAECAw=="
          },
          {
            taskId: task.id,
            type: "json",
            name: "Broken JSON",
            content: "{"
          },
          {
            taskId: task.id,
            type: "text",
            name: "Binary body",
            content: { bytes: [0, 1, 2, 3] }
          }
        ]) {
          failures.push(await tool.execute("invalid-tool", args));
        }
        yield { type: "text_delta", delta: "Validation complete." };
        yield { type: "text_completed", text: "Validation complete." };
      }
    };
    const runs = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );
    const started = await runs.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice validate the results" }
    );

    await runs.processRun(started.run!.id);

    expect(failures.map((result) => result.content)).toEqual([
      "Invalid Tool arguments: /type must be equal to one of the allowed values",
      "JSON Artifact content is invalid",
      "Invalid Tool arguments: /content must be string"
    ]);
    expect(failures.map((result) => result.errorKind)).toEqual([
      "validation",
      "validation",
      "validation"
    ]);
    expect(await store.read((current) => current.artifacts)).toEqual([]);
  });

  it("parses names as slugged mentions", () => {
    const state = createFixtureState();
    expect(
      parseMentions("@alice and @bob please review", state.employees)
    ).toEqual({
      all: false,
      employeeIds: [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002"
      ]
    });
  });

  it("pauses a side-effecting Tool until the user rejects it", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000001";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway()
    );
    const workspace = new WorkspaceService(store, cipher, noopProviderRegistry);

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice publish the update" }
    );
    const processing = runService.processRun(started.run!.id);

    let approval;
    for (let attempt = 0; attempt < 20 && !approval; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      approval = await store.read(
        (current) => current.approvals.find((item) => item.status === "pending") ?? null
      );
    }
    expect(approval).not.toBeNull();
    await workspace.resolveApproval(approval!.id, "rejected");
    const completed = await processing;

    expect(completed.status).toBe("completed");
    const events = await runService.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toContain("approval_requested");
    expect(events.map((event) => event.type)).toContain("approval_resolved");
    expect(events.map((event) => event.type)).toContain("tool_error");
    expect(
      events.find((event) => event.type === "tool_completed")?.payload.isError
    ).toBe(true);
    expect(
      events.find((event) => event.type === "tool_completed")?.payload
    ).toMatchObject({
      result: "The user rejected this Tool call.",
      errorKind: "unauthorized"
    });
  });

  it("executes a side-effecting Tool after approval", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000006";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const calls: ToolExecutionRequest[] = [];
    const toolGateway: ToolGateway = {
      async execute(request) {
        calls.push(request);
        return { content: "Webhook accepted." };
      }
    };
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway(),
      { toolGateway }
    );
    const workspace = new WorkspaceService(store, cipher, noopProviderRegistry);
    const task = await workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Publish update",
        goal: "Publish only after approval.",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice publish the update" }
    );
    const processing = runService.processRun(started.run!.id);
    const approval = await waitForPendingApproval(store, started.run!.id);

    expect(
      (await runService.getRunById(started.run!.id))?.status
    ).toBe("waiting_approval");
    expect(approval.taskId).toBe(task.id);
    expect(
      await store.read((current) =>
        current.tasks.find((item) => item.id === task.id)
      )
    ).toMatchObject({ status: "blocked" });
    await workspace.resolveApproval(approval.id, "approved");
    const completed = await processing;

    expect(completed.status).toBe("completed");
    expect(calls).toHaveLength(1);
    expect(calls[0].tool.name).toBe("post_webhook");
    expect(
      await store.read((current) =>
        current.tasks.find((item) => item.id === task.id)
      )
    ).toMatchObject({ status: "in_progress" });
    expect(
      (await runService.listRunEvents(started.run!.id)).map((event) => event.type)
    ).toEqual(
      expect.arrayContaining([
        "approval_requested",
        "approval_resolved",
        "tool_completed"
      ])
    );
  });

  it("returns approval cancellation as a structured Tool outcome", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000007";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const calls: ToolExecutionRequest[] = [];
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway(),
      {
        toolGateway: {
          async execute(request) {
            calls.push(request);
            return { content: "should not execute" };
          }
        }
      }
    );
    const workspace = new WorkspaceService(store, cipher, noopProviderRegistry);
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice cancel publishing" }
    );
    const processing = runService.processRun(started.run!.id);
    const approval = await waitForPendingApproval(store, started.run!.id);

    await workspace.resolveApproval(approval.id, "cancelled");
    await processing;

    expect(calls).toEqual([]);
    const events = await runService.listRunEvents(started.run!.id);
    expect(
      events.find((event) => event.type === "tool_completed")?.payload
    ).toMatchObject({ isError: true, errorKind: "cancelled" });
    expect(events.map((event) => event.type)).toContain("tool_cancelled");
  });

  it("expires Approval without executing the Tool", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000008";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const cipher = new AesCredentialCipher(TEST_KEY);
    const calls: ToolExecutionRequest[] = [];
    const runService = new ConversationRunService(
      store,
      cipher,
      new ToolCallingModelGateway(),
      {
        approvalTimeoutMs: 20,
        toolGateway: {
          async execute(request) {
            calls.push(request);
            return { content: "should not execute" };
          }
        }
      }
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice let publishing expire" }
    );

    const completed = await runService.processRun(started.run!.id);

    expect(completed.status).toBe("completed");
    expect(calls).toEqual([]);
    expect(
      await store.read((current) =>
        current.approvals.find((item) => item.runId === started.run!.id)
      )
    ).toMatchObject({ status: "expired" });
  });

  it("preserves Approval decisions across worker recovery", async () => {
    const state = createFixtureState();
    const employeeId = "20000000-0000-4000-8000-000000000001";
    const runId = "50000000-0000-4000-8000-000000000025";
    const messageId = "message-approval-restart";
    const toolCallId = "tool-call-approval-restart";
    const now = new Date().toISOString();
    state.messages.push({
      id: messageId,
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      authorType: "employee",
      authorId: employeeId,
      content: "",
      runId,
      status: "streaming",
      createdAt: now,
      updatedAt: now
    });
    state.runs.push({
      id: runId,
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      triggerMessageId: "trigger",
      memberSnapshot: [employeeId],
      status: "waiting_approval",
      createdAt: now
    });
    state.approvals.push({
      id: "approval-after-restart",
      workspaceId: state.workspace.id,
      runId,
      messageId,
      employeeId,
      toolCallId,
      toolName: "post_webhook",
      args: {
        url: "https://example.com/hook",
        body: { launch: true }
      },
      status: "rejected",
      createdAt: now,
      resolvedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const store = new MemoryStore(state);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );

    await runService.recoverInterruptedRuns();

    expect((await runService.getRunById(runId))?.status).toBe("interrupted");
    expect(
      await store.read((current) =>
        current.approvals.find((item) => item.id === "approval-after-restart")
      )
    ).toMatchObject({
      status: "rejected",
      toolCallId,
      employeeId
    });
  });

  it("does not resume or complete a Run cancelled while awaiting approval", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000002";
    addApprovalSkill(state, customSkillId);
    const store = new MemoryStore(state);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new ToolCallingModelGateway()
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice publish the update" }
    );
    const processing = runService.processRun(started.run!.id);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pending = await store.read((current) =>
        current.approvals.some(
          (approval) =>
            approval.runId === started.run!.id && approval.status === "pending"
        )
      );
      if (pending) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await runService.cancelRun(started.run!.id);
    await processing;

    expect((await runService.getRunById(started.run!.id))?.status).toBe(
      "cancelled"
    );
    expect(
      (await runService.listMessages(started.message.conversationId)).at(-1)
        ?.status
    ).toBe("cancelled");
    expect(
      await store.read((current) =>
        current.approvals
          .filter((approval) => approval.runId === started.run!.id)
          .every((approval) => approval.status === "cancelled")
      )
    ).toBe(true);
    const cancelledApproval = await store.read((current) =>
      current.approvals.find((approval) => approval.runId === started.run!.id)
    );
    expect(
      (await runService.listRunEvents(started.run!.id)).find(
        (event) => event.type === "approval_resolved"
      )?.payload
    ).toMatchObject({
      messageId: cancelledApproval?.messageId,
      reason: "run_cancelled"
    });
  });

  it("claims a queued Run only once when workers process it concurrently", async () => {
    const store = new MemoryStoreFixture();
    let attempts = 0;
    const engine: ModelGateway = {
      async *run() {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield { type: "text_delta", delta: "single" };
        yield { type: "text_completed", text: "single" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );

    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice run once" }
    );
    await Promise.all([
      runService.processRun(started.run!.id),
      runService.processRun(started.run!.id)
    ]);

    expect(attempts).toBe(1);
    expect((await runService.getRunById(started.run!.id))?.status).toBe("completed");
  });

  it("marks active Runs as interrupted after a worker restart", async () => {
    const state = createFixtureState();
    state.messages.push({
      id: "streaming-message",
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      authorType: "employee",
      authorId: "20000000-0000-4000-8000-000000000001",
      content: "partial",
      runId: "50000000-0000-4000-8000-000000000001",
      status: "streaming",
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.approvals.push({
      id: "pending-approval",
      workspaceId: state.workspace.id,
      runId: "50000000-0000-4000-8000-000000000001",
      messageId: "streaming-message",
      taskId: "task-approval",
      toolName: "post_webhook",
      args: {},
      status: "pending",
      createdAt: state.workspace.createdAt
    });
    state.runs.push({
      id: "50000000-0000-4000-8000-000000000001",
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      triggerMessageId: "trigger",
      memberSnapshot: ["20000000-0000-4000-8000-000000000001"],
      status: "running",
      createdAt: state.workspace.createdAt
    });
    const store = new MemoryStore(state);
    const gateway = new RecordingModelGateway();
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      gateway
    );

    await runService.recoverInterruptedRuns();

    expect(
      (await runService.getRunById("50000000-0000-4000-8000-000000000001"))
        ?.status
    ).toBe("interrupted");
    expect(
      await store.read(
        (current) =>
          current.messages.find((message) => message.id === "streaming-message")
            ?.status
      )
    ).toBe("interrupted");
    const events = await runService.listRunEvents(
      "50000000-0000-4000-8000-000000000001"
    );
    expect(events.map((event) => event.type)).toContain(
      "employee_turn_interrupted"
    );
    expect(
      events.find((event) => event.type === "approval_resolved")?.payload
    ).toMatchObject({
      messageId: "streaming-message",
      taskId: "task-approval"
    });
    expect(
      await store.read(
        (current) =>
          current.approvals.find(
            (approval) => approval.id === "pending-approval"
          )?.status
      )
    ).toBe("cancelled");
    expect(gateway.requests).toHaveLength(0);
  });

  it("cancels an active Model Gateway and marks partial Messages as cancelled", async () => {
    const store = new MemoryStoreFixture();
    const engine: ModelGateway = {
      async *run(request) {
        if (request.signal?.aborted) throw new Error("aborted");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          request.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
        });
        yield { type: "text_completed", text: "late" };
      }
    };
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice wait forever" }
    );
    const processing = runService.processRun(started.run!.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      await store.read((state) =>
        state.messages.some(
          (message) =>
            message.runId === started.run!.id && message.status === "streaming"
        )
      )
    ).toBe(true);
    await runService.cancelRun(started.run!.id);
    await processing;

    expect((await runService.getRunById(started.run!.id))?.status).toBe("cancelled");
    const messages = await runService.listMessages(started.message.conversationId);
    expect(messages.at(-1)?.status).toBe("cancelled");
    const events = await runService.listRunEvents(started.run!.id);
    expect(events.map((event) => event.type)).toContain(
      "employee_turn_cancelled"
    );
    expect(
      events.find((event) => event.type === "run_cancelled")?.payload
    ).toMatchObject({
      cooperative: true,
      stopRequested: true
    });
  });

  it("observes a cancellation written by another service instance", async () => {
    const store = new MemoryStoreFixture();
    let calls = 0;
    const engine: ModelGateway = {
      async *run(request) {
        calls += 1;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          request.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true }
          );
          if (request.signal?.aborted) {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }
        });
        yield { type: "text_completed", text: "late" };
      }
    };
    const worker = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const web = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      new RecordingModelGateway()
    );
    const started = await worker.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice wait for cross-process cancel" }
    );
    const processing = worker.processRun(started.run!.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await web.cancelRun(started.run!.id);
    await processing;

    expect((await worker.getRunById(started.run!.id))?.status).toBe("cancelled");
    expect(calls).toBe(1);
    expect(
      (await worker.listMessages(started.message.conversationId)).at(-1)?.status
    ).toBe("cancelled");
  });

  it("resumes an interrupted Run and skips already completed Employees", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingModelGateway(() => ["resumed"]);
    const runService = new ConversationRunService(
      store,
      new AesCredentialCipher(TEST_KEY),
      engine
    );
    const started = await runService.startTurn(
      "30000000-0000-4000-8000-000000000001",
      { content: "@alice resume this" }
    );
    await store.update((state) => {
      const run = state.runs.find((item) => item.id === started.run!.id);
      if (run) run.status = "interrupted";
    });

    await runService.resumeRun(started.run!.id);
    await runService.processRun(started.run!.id);

    expect(engine.requests).toHaveLength(1);
    expect((await runService.getRunById(started.run!.id))?.status).toBe("completed");
  });
});

class MemoryStoreFixture extends MemoryStore {
  constructor() {
    super(createFixtureState());
  }
}

function addApprovalSkill(state: AppState, skillId: string): void {
  state.skills.push({
    id: skillId,
    workspaceId: state.workspace.id,
    name: "Publisher",
    description: "Posts approved updates.",
    instructions: "Publish only after approval.",
    inputs: ["payload"],
    outputs: ["receipt"],
    toolNames: ["post_webhook"],
    builtIn: false,
    createdAt: state.workspace.createdAt,
    updatedAt: state.workspace.updatedAt
  });
  state.employees[0].skillIds.push(skillId);
}

async function waitForPendingApproval(
  store: MemoryStore,
  runId: string
): Promise<Approval> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const approval = await store.read(
      (state) =>
        state.approvals.find(
          (item) => item.runId === runId && item.status === "pending"
        ) ?? null
    );
    if (approval) return approval;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Pending Approval was not created");
}

function toolModelGateway(
  toolName: string,
  args: Record<string, unknown>,
  format: (content: string) => string
): ModelGateway {
  return {
    async *run(request) {
      const tool = request.tools.find((item) => item.name === toolName);
      if (!tool) throw new Error(`${toolName} Tool was not available`);
      yield {
        type: "tool_started",
        toolCallId: "test-tool-call",
        toolName,
        args
      };
      const result = await tool.execute(
        "test-tool-call",
        args,
        request.signal
      );
      yield {
        type: "tool_completed",
        toolCallId: "test-tool-call",
        toolName,
        result: result.content,
        isError: Boolean(result.isError),
        errorKind: result.errorKind
      };
      const text = `The Tool returned ${format(result.content)}.`;
      yield { type: "text_delta", delta: text };
      yield { type: "text_completed", text };
    }
  };
}
