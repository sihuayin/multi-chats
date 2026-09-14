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
        schemaVersion: 4,
        discussions: []
      });
    } finally {
      await store.update((state) => {
        Object.assign(state, structuredClone(original));
      });
    }
  });
});
