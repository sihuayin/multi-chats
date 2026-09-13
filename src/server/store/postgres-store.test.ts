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

  it("round-trips Discussion aggregates", async () => {
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
    });

    expect(
      await store.read((state) =>
        state.discussions.find((item) => item.id === id)
      )
    ).toEqual(discussion);

    await store.update((state) => {
      state.discussions = state.discussions.filter(
        (item) => item.id !== discussion.id
      );
    });
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
        schemaVersion: 2,
        discussions: []
      });
    } finally {
      await store.update((state) => {
        Object.assign(state, structuredClone(original));
      });
    }
  });
});
