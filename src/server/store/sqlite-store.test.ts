import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "@/server/store/sqlite-store";

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
});
