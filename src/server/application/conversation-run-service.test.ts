import { describe, expect, it } from "vitest";
import {
  ConversationRunService,
  parseMentions
} from "@/server/application/conversation-run-service";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import {
  createFixtureState,
  RecordingEngine,
  TEST_KEY,
  ToolCallingEngine
} from "@/server/test-support/fixtures";
import { MemoryStore } from "@/server/store/memory-store";
import { WorkspaceService } from "@/server/application/workspace-service";
import type { AgentEngine } from "@/server/application/agent-engine";

describe("ConversationRun", () => {
  it("stores a Message without starting a Run when no Employee is mentioned", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingEngine();
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
    const engine = new RecordingEngine(() => ["Hello", " from Alice"]);
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
      "run_completed"
    ]);
  });

  it("executes @all members sequentially and gives later members earlier responses", async () => {
    const store = new MemoryStoreFixture();
    const engine = new RecordingEngine(() => ["response"]);
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
    const runService = new ConversationRunService(store, cipher, new ToolCallingEngine());
    const workspace = new WorkspaceService(store, cipher);

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
    expect(
      events.find((event) => event.type === "tool_completed")?.payload.isError
    ).toBe(true);
  });

  it("claims a queued Run only once when workers process it concurrently", async () => {
    const store = new MemoryStoreFixture();
    let attempts = 0;
    const engine: AgentEngine = {
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
    state.runs.push({
      id: "50000000-0000-4000-8000-000000000001",
      workspaceId: state.workspace.id,
      conversationId: "30000000-0000-4000-8000-000000000001",
      triggerMessageId: "trigger",
      memberSnapshot: ["20000000-0000-4000-8000-000000000001"],
      status: "running",
      createdAt: state.workspace.createdAt
    });
    const runService = new ConversationRunService(
      new MemoryStore(state),
      new AesCredentialCipher(TEST_KEY),
      new RecordingEngine()
    );

    await runService.recoverInterruptedRuns();

    expect(
      (await runService.getRunById("50000000-0000-4000-8000-000000000001"))
        ?.status
    ).toBe("interrupted");
  });
});

class MemoryStoreFixture extends MemoryStore {
  constructor() {
    super(createFixtureState());
  }
}
