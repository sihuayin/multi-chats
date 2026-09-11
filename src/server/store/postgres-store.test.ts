import { afterAll, describe, expect, it } from "vitest";
import { PostgresStore } from "@/server/store/postgres-store";

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
});
