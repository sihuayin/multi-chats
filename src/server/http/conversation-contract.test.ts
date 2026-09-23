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
import type { ModelGateway } from "@/server/application/model-gateway";

const originalModelMode = process.env.MODEL_MODE;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  setServicesForTests(undefined);
  if (originalModelMode === undefined) delete process.env.MODEL_MODE;
  else process.env.MODEL_MODE = originalModelMode;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function setupContractServices(
  initialState = createFixtureState(),
  gateway: ModelGateway = new FakeModelGateway()
) {
  process.env.MODEL_MODE = "fake";
  process.env.DATABASE_URL = "postgres://contract-test";
  const store = new MemoryStore(initialState);
  setStoreForTests(store);
  const runService = new ConversationRunService(
    store,
    new AesCredentialCipher(TEST_KEY),
    gateway
  );
  setServicesForTests({
    workspace: getServices().workspace,
    sources: getServices().sources,
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

  it("stops, resumes, retries, and cancels Task Runs", async () => {
    const { store } = setupContractServices();
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const task = await getServices().workspace.createTask(conversationId, {
      title: "Recoverable Task",
      goal: "Exercise Task Run recovery.",
      assigneeIds: ["20000000-0000-4000-8000-000000000001"]
    });
    const command = (taskId: string, name: string, key: string) =>
      new Request(`http://localhost/api/tasks/${taskId}/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key
        },
        body: "{}"
      });

    const firstStart = await handleApiRequest(
      command(task.id, "run", "recovery-start-one"),
      ["tasks", task.id, "run"]
    );
    const firstRun = (await firstStart.json()) as { run: { id: string } };
    const stopped = await handleApiRequest(
      command(task.id, "stop", "recovery-stop"),
      ["tasks", task.id, "stop"]
    );
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({
      task: { id: task.id, status: "in_progress" },
      run: { id: firstRun.run.id, status: "cancelled" }
    });

    const secondStart = await handleApiRequest(
      command(task.id, "run", "recovery-start-two"),
      ["tasks", task.id, "run"]
    );
    expect(secondStart.status).toBe(202);
    const secondRun = (await secondStart.json()) as { run: { id: string } };
    expect(secondRun.run.id).not.toBe(firstRun.run.id);

    await store.update((state) => {
      const run = state.runs.find((item) => item.id === secondRun.run.id);
      if (!run) throw new Error("Expected Task Run");
      run.status = "interrupted";
    });
    const resumed = await handleApiRequest(
      command(task.id, "resume", "recovery-resume"),
      ["tasks", task.id, "resume"]
    );
    expect(resumed.status).toBe(202);
    await expect(resumed.json()).resolves.toMatchObject({
      task: { id: task.id, status: "in_progress" },
      run: { id: secondRun.run.id, status: "queued" }
    });
    await getServices().runs.processRun(secondRun.run.id);

    const secondTask = await getServices().workspace.createTask(conversationId, {
      title: "Cancel Task Run",
      goal: "Cancel the active Run with the Task.",
      assigneeIds: ["20000000-0000-4000-8000-000000000001"]
    });
    const startedForCancel = await handleApiRequest(
      command(secondTask.id, "run", "cancel-start"),
      ["tasks", secondTask.id, "run"]
    );
    const cancelledRun = (await startedForCancel.json()) as {
      run: { id: string };
    };
    const cancelled = await handleApiRequest(
      command(secondTask.id, "cancel", "cancel-task"),
      ["tasks", secondTask.id, "cancel"]
    );
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({
      task: { id: secondTask.id, status: "cancelled" },
      run: { id: cancelledRun.run.id, status: "cancelled" }
    });
  });

  it("does not resume interrupted Task Runs while active or terminal", async () => {
    const { store } = setupContractServices();
    const conversationId = "30000000-0000-4000-8000-000000000001";
    const firstTask = await getServices().workspace.createTask(conversationId, {
      title: "Interrupted Task",
      goal: "Remain interrupted until recovery is safe.",
      assigneeIds: ["20000000-0000-4000-8000-000000000001"]
    });
    const firstStart = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${firstTask.id}/run`, {
        method: "POST",
        headers: { "idempotency-key": "interrupted-start" },
        body: "{}"
      }),
      ["tasks", firstTask.id, "run"]
    );
    const interrupted = (await firstStart.json()) as { run: { id: string } };
    await store.update((state) => {
      state.runs.find((run) => run.id === interrupted.run.id)!.status =
        "interrupted";
    });

    const secondTask = await getServices().workspace.createTask(conversationId, {
      title: "Active Task",
      goal: "Keep the Conversation busy.",
      assigneeIds: ["20000000-0000-4000-8000-000000000002"]
    });
    await handleApiRequest(
      new Request(`http://localhost/api/tasks/${secondTask.id}/run`, {
        method: "POST",
        headers: { "idempotency-key": "active-start" },
        body: "{}"
      }),
      ["tasks", secondTask.id, "run"]
    );

    const blockedResume = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${firstTask.id}/resume`, {
        method: "POST",
        headers: { "idempotency-key": "blocked-resume" },
        body: "{}"
      }),
      ["tasks", firstTask.id, "resume"]
    );
    expect(blockedResume.status).toBe(409);
    await expect(blockedResume.json()).resolves.toMatchObject({
      code: "active_run"
    });
    expect(
      await store.read(
        (state) =>
          state.runs.find((run) => run.id === interrupted.run.id)?.status
      )
    ).toBe("interrupted");

    await handleApiRequest(
      new Request(`http://localhost/api/tasks/${secondTask.id}/stop`, {
        method: "POST",
        headers: { "idempotency-key": "active-stop" },
        body: "{}"
      }),
      ["tasks", secondTask.id, "stop"]
    );
    const cancelled = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${firstTask.id}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": "terminal-cancel" },
        body: "{}"
      }),
      ["tasks", firstTask.id, "cancel"]
    );
    expect(cancelled.status).toBe(200);

    const terminalResume = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${firstTask.id}/resume`, {
        method: "POST",
        headers: { "idempotency-key": "terminal-resume" },
        body: "{}"
      }),
      ["tasks", firstTask.id, "resume"]
    );
    expect(terminalResume.status).toBe(409);
    await expect(terminalResume.json()).resolves.toMatchObject({
      code: "task_not_resumable"
    });
    expect(
      await store.read(
        (state) =>
          state.runs.find((run) => run.id === interrupted.run.id)?.status
      )
    ).toBe("interrupted");
  });

  it("publishes Task-owned Artifacts and moves the Task to review", async () => {
    const state = createFixtureState();
    const skillId = "40000000-0000-4000-8000-000000000009";
    state.skills.push({
      id: skillId,
      workspaceId: state.workspace.id,
      name: "Task publisher",
      description: "Publishes Task Artifacts.",
      instructions: "Attach the result and move the Task to review.",
      inputs: ["result"],
      outputs: ["artifact"],
      toolNames: ["update_task", "attach_artifact"],
      builtIn: false,
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });
    state.employees[0].skillIds.push(skillId);
    const gateway: ModelGateway = {
      async *run(request) {
        const updateTask = request.tools.find(
          (tool) => tool.name === "update_task"
        );
        const attachArtifact = request.tools.find(
          (tool) => tool.name === "attach_artifact"
        );
        if (!updateTask || !attachArtifact) {
          throw new Error("Task Artifact Tools were not available");
        }
        const taskId = request.prompt.match(/^Task ([^ ]+) "/m)?.[1];
        if (!taskId) throw new Error("Task context was not provided");
        await attachArtifact.execute("task-output-artifact", {
          taskId,
          type: "json",
          name: "Task result",
          content: JSON.stringify({ complete: true })
        });
        await updateTask.execute("task-output-review", {
          taskId,
          status: "review"
        });
        yield { type: "text_delta", delta: "Task Artifact published." };
        yield { type: "text_completed", text: "Task Artifact published." };
      }
    };
    const { store } = setupContractServices(state, gateway);
    const task = await getServices().workspace.createTask(
      state.conversations[0].id,
      {
        title: "Publish Task result",
        goal: "Produce a durable output.",
        assigneeIds: [state.employees[0].id]
      }
    );
    const startedResponse = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: { "idempotency-key": "publish-task-artifact" },
        body: "{}"
      }),
      ["tasks", task.id, "run"]
    );
    const started = (await startedResponse.json()) as { run: { id: string } };

    await getServices().runs.processRun(started.run.id);

    const persisted = await store.read((current) => ({
      task: current.tasks.find((item) => item.id === task.id),
      run: current.runs.find((item) => item.id === started.run.id),
      artifact: current.artifacts.find((item) => item.ownerId === task.id),
      events: current.runEvents.filter(
        (event) => event.runId === started.run.id
      ),
      messages: current.messages.filter(
        (message) => message.runId === started.run.id
      )
    }));
    expect(persisted.task?.status).toBe("review");
    expect(persisted.artifact).toMatchObject({
      ownerType: "task",
      ownerId: task.id,
      runId: started.run.id,
      type: "json",
      name: "Task result"
    });
    expect(persisted.task?.history).toContainEqual(
      expect.objectContaining({
        action: "artifact_created",
        artifactId: persisted.artifact?.id,
        runId: started.run.id
      })
    );
    expect(
      persisted.events.some((event) => event.type === "artifact_created")
    ).toBe(true);
    expect(
      persisted.messages.some((message) =>
        message.content.includes('"complete":true')
      )
    ).toBe(false);
  });

  it("preserves prior Task context and Artifacts after a failed Task Run", async () => {
    const { store } = setupContractServices();
    const task = await getServices().workspace.createTask(
      "30000000-0000-4000-8000-000000000001",
      {
        title: "Fail without losing history",
        goal: "FAIL_MODEL",
        assigneeIds: ["20000000-0000-4000-8000-000000000001"]
      }
    );
    const artifact = await getServices().workspace.createArtifact(
      task.id,
      {
        type: "text",
        name: "Existing result",
        content: "Keep this Artifact."
      },
      "user"
    );
    await handleApiRequest(
      new Request(
        "http://localhost/api/conversations/30000000-0000-4000-8000-000000000001/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "Keep this context." })
        }
      ),
      ["conversations", "30000000-0000-4000-8000-000000000001", "messages"]
    );

    const startedResponse = await handleApiRequest(
      new Request(`http://localhost/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: { "idempotency-key": "failed-task-run" },
        body: "{}"
      }),
      ["tasks", task.id, "run"]
    );
    const started = (await startedResponse.json()) as { run: { id: string } };
    const failed = await getServices().runs.processRun(started.run.id);

    const persisted = await store.read((current) => ({
      task: current.tasks.find((item) => item.id === task.id),
      artifacts: current.artifacts.filter((item) => item.ownerId === task.id),
      messages: current.messages.filter(
        (message) =>
          message.conversationId === task.conversationId
      )
    }));
    expect(failed.status).toBe("failed");
    expect(persisted.task?.status).toBe("in_progress");
    expect(persisted.task?.history.map((entry) => entry.status)).toEqual([
      "draft",
      "draft",
      "in_progress"
    ]);
    expect(persisted.artifacts).toEqual([artifact]);
    expect(
      persisted.messages.some(
        (message) => message.content === "Keep this context."
      )
    ).toBe(true);
    expect(
      persisted.messages.some((message) =>
        message.content.includes("Partial failure output.")
      )
    ).toBe(true);
  });

  it("toggles a Conversation's retrieval exclusion over HTTP", async () => {
    const { store } = setupContractServices();
    const conversation = await store.read((state) => state.conversations[0]);
    expect(conversation.retrievalExcluded).toBe(false);

    const response = await handleApiRequest(
      new Request(`http://localhost/api/conversations/${conversation.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retrievalExcluded: true })
      }),
      ["conversations", conversation.id]
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: conversation.id,
      retrievalExcluded: true
    });
    await expect(
      store.read(
        (state) =>
          state.conversations.find((item) => item.id === conversation.id)
              ?.retrievalExcluded
      )
    ).resolves.toBe(true);
    // Exclusion narrows retrieval only: the Conversation stays readable.
    const messages = await handleApiRequest(
      new Request(
        `http://localhost/api/conversations/${conversation.id}/messages`
      ),
      ["conversations", conversation.id, "messages"]
    );
    expect(messages.status).toBe(200);
  });
});
