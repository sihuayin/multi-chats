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
      "message_delta",
      "message_delta",
      "message_completed",
      "employee_turn_completed",
      "run_completed"
    ]);
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
    ).toEqual(expect.arrayContaining(["model_error", "run_error"]));
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
    ).rejects.toThrow("Task status is not allowed for Employee updates");
    await expect(
      employeeTool.execute("tool-call", {
        taskId: task.id,
        status: "cancelled"
      })
    ).rejects.toThrow("Task status is not allowed for Employee updates");
    expect(
      (await store.read((current) =>
        current.tasks.find((item) => item.id === task.id)
      ))?.status
    ).toBe("review");
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
    state.skills.push({
      id: customSkillId,
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
    state.employees[0].skillIds.push(customSkillId);
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
  });

  it("does not resume or complete a Run cancelled while awaiting approval", async () => {
    const state = createFixtureState();
    const customSkillId = "40000000-0000-4000-8000-000000000002";
    state.skills.push({
      id: customSkillId,
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
    state.employees[0].skillIds.push(customSkillId);
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
