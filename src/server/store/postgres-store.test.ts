import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresStore } from "@/server/store/postgres-store";
import { createFixtureDiscussion } from "@/server/test-support/fixtures";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("PostgresStore", () => {
  const store = new PostgresStore(databaseUrl!);

  afterAll(async () => {
    await store.close();
  });

  it("migrates and persists a locked Workspace update", async () => {
    await store.migrate();
    await store.migrate();
    const original = await store.read((state) => state.workspace.name);
    const originalWorkspaceId = await store.read((state) => state.workspace.id);
    const updated = `Workspace ${Date.now()}`;

    await store.update((state) => {
      state.workspace.name = updated;
    });

    expect(await store.read((state) => state.workspace.name)).toBe(updated);
    expect(await store.read((state) => state.workspace.id)).toBe(originalWorkspaceId);
    await store.update((state) => {
      state.workspace.name = original;
    });
  });

  it("round-trips Discussion and runtime contract aggregates", async () => {
    await store.migrate();
    const discussion = createFixtureDiscussion({
      id: randomUUID()
    });
    const id = discussion.id;

    await store.update((state) => {
      state.discussions = state.discussions.filter(
        (item) => item.id !== discussion.id
      );
      state.discussions.push(discussion);
      state.providerAttempts.push({
        id: `attempt-${id}`,
        workspaceId: state.workspace.id,
        purpose: "discussion_turn",
        provider: "openai",
        modelId: "test-model",
        targetOrder: 0,
        attempt: 1,
        status: "succeeded",
        usage: { source: "unknown" },
        startedAt: state.workspace.createdAt
      });
      state.modelPricing.push({
        id: `pricing-${id}`,
        workspaceId: state.workspace.id,
        provider: "openai",
        modelId: "test-model",
        currency: "USD",
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        effectiveAt: state.workspace.createdAt,
        source: "test",
        version: "1",
        createdAt: state.workspace.createdAt
      });
    });

    expect(
      await store.read((state) =>
        state.discussions.find((item) => item.id === id)
      )
    ).toEqual(discussion);
    expect(
      await store.read(
        (state) => state.providerAttempts.find((item) => item.id === `attempt-${id}`)
      )
    ).toMatchObject({ status: "succeeded" });
    expect(
      await store.read(
        (state) => state.modelPricing.find((item) => item.id === `pricing-${id}`)
      )
    ).toMatchObject({ version: "1" });

    await store.update((state) => {
      state.discussions = state.discussions.filter(
        (item) => item.id !== discussion.id
      );
      state.providerAttempts = state.providerAttempts.filter(
        (item) => item.id !== `attempt-${id}`
      );
      state.modelPricing = state.modelPricing.filter(
        (item) => item.id !== `pricing-${id}`
      );
    });
  });

  it("rejects runtime records that contain credentials", async () => {
    await expect(
      store.update((state) => {
        state.providerAttempts.push({
          id: `attempt-credential-${randomUUID()}`,
          workspaceId: state.workspace.id,
          purpose: "conversation",
          provider: "openai",
          modelId: "test-model",
          targetOrder: 0,
          attempt: 1,
          status: "succeeded",
          usage: { source: "unknown" },
          credential: "must-not-persist",
          startedAt: state.workspace.createdAt
        } as never);
      })
    ).rejects.toThrow("Workspace providerAttempts are invalid");
  });

  it("migrates legacy state in PostgreSQL", async () => {
    const original = await store.read((state) => structuredClone(state));

    try {
      await store.update((state) => {
        const legacy = state as unknown as Record<string, unknown>;
        legacy.schemaVersion = 1;
        delete legacy.discussions;
      });
      await store.migrate();

      expect(
        await store.read((state) => ({
          schemaVersion: state.schemaVersion,
          discussions: state.discussions
        }))
      ).toEqual({
        schemaVersion: 5,
        discussions: []
      });
    } finally {
      await store.update((state) => {
        Object.assign(state, structuredClone(original));
      });
    }
  });

  it("round-trips optional Task, Run, and Message correlations", async () => {
    await store.migrate();
    const suffix = randomUUID();
    const providerId = `provider-${suffix}`;
    const employeeId = `employee-${suffix}`;
    const conversationId = `conversation-${suffix}`;
    const taskId = `task-${suffix}`;
    const messageId = `message-${suffix}`;
    const runId = `run-${suffix}`;
    const now = new Date().toISOString();

    await store.update((state) => {
      state.providers.push({
        id: providerId,
        workspaceId: state.workspace.id,
        provider: "openai",
        label: `Correlation provider ${suffix}`,
        encryptedCredential: "test-credential",
        createdAt: now,
        updatedAt: now
      });
      state.employees.push({
        id: employeeId,
        workspaceId: state.workspace.id,
        name: `Correlation Employee ${suffix}`,
        identity: "Test correlation persistence.",
        providerCredentialId: providerId,
        modelId: "test-model",
        skillIds: [],
        active: true,
        createdAt: now,
        updatedAt: now
      });
      state.conversations.push({
        id: conversationId,
        workspaceId: state.workspace.id,
        title: `Correlation Conversation ${suffix}`,
        memberIds: [employeeId],
        createdAt: now,
        updatedAt: now
      });
      state.tasks.push({
        id: taskId,
        workspaceId: state.workspace.id,
        conversationId,
        title: "Correlated Task",
        goal: "Preserve PostgreSQL correlation.",
        assigneeIds: [employeeId],
        status: "in_progress",
        history: [
          {
            status: "in_progress",
            at: now,
            actorId: "user",
            runId
          }
        ],
        createdAt: now,
        updatedAt: now
      });
      state.messages.push({
        id: messageId,
        workspaceId: state.workspace.id,
        conversationId,
        taskId,
        authorType: "system",
        authorId: "user",
        content: "Task started.",
        runId,
        status: "complete",
        createdAt: now,
        updatedAt: now
      });
      state.runs.push({
        id: runId,
        workspaceId: state.workspace.id,
        conversationId,
        taskId,
        triggerMessageId: messageId,
        memberSnapshot: [employeeId],
        status: "running",
        createdAt: now,
        startedAt: now
      });
    });

    try {
      expect(
        await store.read((state) => ({
          task: state.tasks.find((item) => item.id === taskId),
          message: state.messages.find((item) => item.id === messageId),
          run: state.runs.find((item) => item.id === runId)
        }))
      ).toMatchObject({
        task: {
          id: taskId,
          history: [{ runId }]
        },
        message: {
          id: messageId,
          taskId,
          runId
        },
        run: {
          id: runId,
          taskId,
          triggerMessageId: messageId
        }
      });
    } finally {
      await store.update((state) => {
        state.providers = state.providers.filter(
          (item) => item.id !== providerId
        );
        state.employees = state.employees.filter(
          (item) => item.id !== employeeId
        );
        state.conversations = state.conversations.filter(
          (item) => item.id !== conversationId
        );
        state.tasks = state.tasks.filter((item) => item.id !== taskId);
        state.messages = state.messages.filter(
          (item) => item.id !== messageId
        );
        state.runs = state.runs.filter((item) => item.id !== runId);
      });
    }
  });
});
