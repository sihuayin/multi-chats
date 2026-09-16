import { afterEach, describe, expect, it } from "vitest";
import { getServices, setServicesForTests } from "@/server/application/services";
import { handleApiRequest } from "@/server/http/router";
import { MemoryStore } from "@/server/store/memory-store";
import { setStoreForTests } from "@/server/store";
import {
  createFixtureState,
  TEST_KEY
} from "@/server/test-support/fixtures";
import { AesCredentialCipher } from "@/server/security/credential-cipher";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import { FakeModelGateway } from "@/server/adapters/model/model-gateway";

const originalModelMode = process.env.MODEL_MODE;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  setServicesForTests(undefined);
  if (originalModelMode === undefined) delete process.env.MODEL_MODE;
  else process.env.MODEL_MODE = originalModelMode;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function setupContractServices() {
  process.env.MODEL_MODE = "fake";
  process.env.DATABASE_URL = "postgres://contract-test";
  const store = new MemoryStore(createFixtureState());
  setStoreForTests(store);
  const runService = new ConversationRunService(
    store,
    new AesCredentialCipher(TEST_KEY),
    new FakeModelGateway()
  );
  setServicesForTests({
    workspace: getServices().workspace,
    runs: runService,
    discussions: new DiscussionOrchestrator(store, runService)
  });
  return { store, runService };
}

describe("Conversation HTTP and SSE contract", () => {
  it("translates a mentioned Message into an ordered persisted Run event stream", async () => {
    setupContractServices();

    const startedResponse = await handleApiRequest(
      new Request("http://localhost/api/conversations/conversation/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "@alice prepare the launch brief"
        })
      }),
      [
        "conversations",
        "30000000-0000-4000-8000-000000000001",
        "messages"
      ]
    );
    expect(startedResponse.status).toBe(202);
    const started = (await startedResponse.json()) as {
      run: { id: string };
    };
    expect(started.run.id).toBeTruthy();

    const { runs } = getServices();
    const streamResponse = await handleApiRequest(
      new Request(
        `http://localhost/api/runs/${started.run.id}/events?after=0`
      ),
      ["runs", started.run.id, "events"]
    );
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const decoder = new TextDecoder();
    const processing = runs.processRun(started.run.id);
    let streamText = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamText += decoder.decode(chunk.value, { stream: true });
      if (streamText.includes("run_completed")) break;
    }
    const completed = await processing;
    expect(completed.status).toBe("completed");
    const events = streamText
      .split("\n\n")
      .map((frame) =>
        frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length)
      )
      .filter((data): data is string => Boolean(data))
      .map((data) => JSON.parse(data) as { sequence: number; type: string });

    expect(events.map((event) => event.sequence)).toEqual(
      [...events].map((event) => event.sequence).sort((left, right) => left - right)
    );
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes[0]).toBe("run_started");
    expect(eventTypes[1]).toBe("employee_turn_started");
    expect(eventTypes[2]).toBe("skill_loaded");
    expect(eventTypes).toContain("provider_attempt_started");
    expect(eventTypes).toContain("provider_attempt_completed");
    expect(eventTypes.filter((type) => type === "message_delta").length).toBeGreaterThan(0);
    expect(eventTypes.at(-4)).toBe("provider_attempt_completed");
    expect(eventTypes.at(-3)).toBe("message_completed");
    expect(eventTypes.at(-2)).toBe("employee_turn_completed");
    expect(eventTypes.at(-1)).toBe("run_completed");

    const messages = await runs.listMessages(
      "30000000-0000-4000-8000-000000000001"
    );
    expect(messages.at(-1)).toMatchObject({
      authorType: "employee",
      status: "complete"
    });
  });

  it("starts an assigned Task as one idempotent Conversation Run", async () => {
    const { store } = setupContractServices();
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const task = await getServices().workspace.createTask(conversationId, {
      title: "Prepare launch brief",
      goal: "Produce a concise launch brief.",
      assigneeIds: [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002"
      ]
    });
    const startRequest = (taskId: string, key: string) =>
      new Request(`http://localhost/api/tasks/${taskId}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key
        },
        body: "{}"
      });

    const firstResponse = await handleApiRequest(
      startRequest(task.id, "task-start-one"),
      ["tasks", task.id, "run"]
    );
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json()) as {
      message: { id: string; taskId?: string; runId?: string };
      run: {
        id: string;
        taskId?: string;
        triggerMessageId: string;
        memberSnapshot: string[];
      };
    };
    expect(first.run).toMatchObject({
      taskId: task.id,
      triggerMessageId: first.message.id,
      memberSnapshot: [
        "20000000-0000-4000-8000-000000000001",
        "20000000-0000-4000-8000-000000000002"
      ]
    });
    expect(first.message).toMatchObject({
      taskId: task.id,
      runId: first.run.id
    });

    const replayResponse = await handleApiRequest(
      startRequest(task.id, "task-start-one"),
      ["tasks", task.id, "run"]
    );
    const replay = (await replayResponse.json()) as {
      run: { id: string };
    };
    expect(replay.run.id).toBe(first.run.id);
    expect(await store.read((state) => state.runs)).toHaveLength(1);

    const secondTask = await getServices().workspace.createTask(conversationId, {
      title: "Second Task",
      goal: "This Task must wait for the active Run.",
      assigneeIds: ["20000000-0000-4000-8000-000000000002"]
    });
    const conflictResponse = await handleApiRequest(
      startRequest(secondTask.id, "task-start-two"),
      ["tasks", secondTask.id, "run"]
    );
    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      code: "active_run"
    });

    await getServices().runs.processRun(first.run.id);
    const state = await store.read((current) => ({
      task: current.tasks.find((item) => item.id === task.id),
      secondTask: current.tasks.find((item) => item.id === secondTask.id),
      run: current.runs.find((item) => item.id === first.run.id),
      messages: current.messages
        .filter((message) => message.runId === first.run.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }));

    expect(state.task).toMatchObject({
      status: "in_progress",
      history: expect.arrayContaining([
        expect.objectContaining({ runId: first.run.id })
      ])
    });
    expect(state.secondTask?.status).toBe("draft");
    expect(state.run?.status).toBe("completed");
    expect(
      state.messages
        .filter((message) => message.authorType === "employee")
        .map((message) => message.authorId)
    ).toEqual([
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002"
    ]);
  });

  it("rejects Task start when an assignee is no longer in the Conversation", async () => {
    const { runService, store } = setupContractServices();
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const task = await getServices().workspace.createTask(conversationId, {
      title: "Invalid assignee",
      goal: "Do not start the Run.",
      assigneeIds: ["20000000-0000-4000-8000-000000000001"]
    });
    await store.update((state) => {
      state.conversations[0].memberIds = [
        "20000000-0000-4000-8000-000000000002"
      ];
    });

    await expect(runService.startTask(task.id)).rejects.toMatchObject({
      code: "task_assignees_invalid"
    });
    expect(await store.read((state) => state.runs)).toHaveLength(0);
  });

  it("keeps Tool execution inside the Task Run seam", async () => {
    const { store } = setupContractServices();
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const task = await getServices().workspace.createTask(conversationId, {
      title: "Read current time",
      goal: "USE_CURRENT_TIME",
      assigneeIds: ["20000000-0000-4000-8000-000000000001"]
    });
    const response = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "task-tool-run"
        },
        body: "{}"
      }),
      ["tasks", task.id, "run"]
    );
    const started = (await response.json()) as { run: { id: string } };

    await getServices().runs.processRun(started.run.id);
    const state = await store.read((current) => ({
      messages: current.messages.filter(
        (message) => message.runId === started.run.id
      ),
      events: current.runEvents.filter(
        (event) => event.runId === started.run.id
      )
    }));

    expect(state.messages.some((message) => message.content.includes("Current time:"))).toBe(
      true
    );
    expect(state.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool_started", "tool_completed"])
    );
  });
});
