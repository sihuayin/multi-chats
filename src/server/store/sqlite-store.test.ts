import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createInitialState } from "@/server/store/initial-state";
import { SqliteStore } from "@/server/store/sqlite-store";
import { createFixtureDiscussion } from "@/server/test-support/fixtures";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("SqliteStore", () => {
  it("creates the default Workspace and persists updates across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "multi-chats-sqlite-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const first = new SqliteStore(path);

    expect(await first.read((state) => state.workspace.name)).toBe("My Workspace");
    await first.update((state) => {
      state.workspace.name = "SQLite Workspace";
    });
    await first.close();

    const second = new SqliteStore(path);
    expect(await second.read((state) => state.workspace.name)).toBe(
      "SQLite Workspace"
    );
    await second.close();
  });

  it("serializes concurrent updates", async () => {
    const store = new SqliteStore(":memory:");
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update((state) => {
          state.groups.push({
            id: `group-${index}`,
            workspaceId: state.workspace.id,
            name: `Group ${index}`,
            memberIds: [],
            createdAt: state.workspace.createdAt,
            updatedAt: state.workspace.updatedAt
          });
        })
      )
    );

    expect(await store.read((state) => state.groups)).toHaveLength(10);
    await store.close();
  });

  it("round-trips Discussion aggregates across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "multi-chats-sqlite-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const first = new SqliteStore(path);
    const discussion = createFixtureDiscussion();

    await first.update((state) => {
      state.discussions.push(discussion);
    });
    await first.close();

    const second = new SqliteStore(path);
    expect(await second.read((state) => state.discussions)).toEqual([
      discussion
    ]);
    await second.close();
  });

  it("migrates and persists a legacy SQLite state file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "multi-chats-sqlite-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite");
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const legacy = structuredClone(
      createInitialState(workspaceId)
    ) as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    delete legacy.discussions;
    legacy.artifacts = [
      {
        id: "artifact-legacy",
        workspaceId,
        taskId: "task-legacy",
        type: "text",
        name: "Legacy",
        content: "Legacy artifact",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE app_state (
        workspace_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    database
      .prepare(
        "INSERT INTO app_state (workspace_id, state, updated_at) VALUES (?, ?, ?)"
      )
      .run(workspaceId, JSON.stringify(legacy), "2026-01-01T00:00:00.000Z");
    database.close();

    const store = new SqliteStore(path);
    expect(
      await store.read((state) => ({
        schemaVersion: state.schemaVersion,
        discussions: state.discussions,
        artifact: state.artifacts[0]
      }))
    ).toEqual({
      schemaVersion: 2,
      discussions: [],
      artifact: expect.objectContaining({
        ownerType: "task",
        ownerId: "task-legacy"
      })
    });
    await store.close();

    const migratedDatabase = new DatabaseSync(path);
    const row = migratedDatabase
      .prepare("SELECT state FROM app_state WHERE workspace_id = ?")
      .get(workspaceId) as { state: string };
    const persisted = JSON.parse(row.state) as {
      schemaVersion: number;
      discussions: unknown[];
      artifacts: Array<Record<string, unknown>>;
    };
    migratedDatabase.close();

    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.discussions).toEqual([]);
    expect(persisted.artifacts[0]).toMatchObject({
      ownerType: "task",
      ownerId: "task-legacy"
    });
    expect(persisted.artifacts[0]).not.toHaveProperty("taskId");
  });
});
