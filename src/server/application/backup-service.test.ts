import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceBackup,
  restoreWorkspaceBackup
} from "@/server/application/backup-service";
import { createInitialState } from "@/server/store/initial-state";
import { SqliteStore } from "@/server/store/sqlite-store";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("Workspace backup and restore", () => {
  it("restores persisted Workspace state into a clean store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "multi-chats-backup-"));
    directories.push(directory);
    const source = new SqliteStore(join(directory, "source.sqlite"));
    await source.update((state) => {
      state.workspace.name = "Backed up Workspace";
      state.groups.push({
        id: "group-backup",
        workspaceId: state.workspace.id,
        name: "Backup Group",
        memberIds: [],
        createdAt: state.workspace.createdAt,
        updatedAt: state.workspace.updatedAt
      });
    });
    const backup = await createWorkspaceBackup(source);
    await source.close();

    const target = new SqliteStore(join(directory, "target.sqlite"));
    await restoreWorkspaceBackup(target, backup);
    expect(await target.read((state) => state.workspace.name)).toBe(
      "Backed up Workspace"
    );
    expect(await target.read((state) => state.groups)).toContainEqual(
      expect.objectContaining({ id: "group-backup", name: "Backup Group" })
    );
    await target.close();
  });

  it("rejects malformed backups without modifying the Workspace", async () => {
    const store = new SqliteStore(":memory:");
    const original = await store.read((state) => state.workspace.name);
    const valid = createInitialState(
      "00000000-0000-4000-8000-000000000001"
    );
    const invalidBackups = [
      '{"workspace":{},"groups":[]}',
      JSON.stringify({
        ...valid,
        employees: [null]
      }),
      JSON.stringify({
        ...valid,
        runs: [
          {
            id: "run-invalid",
            workspaceId: valid.workspace.id,
            conversationId: "conversation-invalid",
            triggerMessageId: "message-invalid",
            memberSnapshot: [],
            status: "unknown",
            createdAt: valid.workspace.createdAt
          }
        ]
      }),
      JSON.stringify({
        ...valid,
        artifacts: [
          {
            id: "artifact-invalid",
            workspaceId: valid.workspace.id,
            taskId: "task-invalid",
            type: "binary",
            name: "Binary",
            content: "AA==",
            createdAt: valid.workspace.createdAt,
            updatedAt: valid.workspace.updatedAt
          }
        ]
      }),
      JSON.stringify({
        ...valid,
        conversations: [
          {
            id: "conversation-invalid",
            workspaceId: valid.workspace.id,
            title: "Invalid member",
            memberIds: ["missing-employee"],
            createdAt: valid.workspace.createdAt,
            updatedAt: valid.workspace.updatedAt
          }
        ]
      }),
      JSON.stringify({
        ...valid,
        artifacts: [
          {
            id: "artifact-dangling",
            workspaceId: valid.workspace.id,
            taskId: "missing-task",
            type: "text",
            name: "Dangling",
            content: "Missing Task",
            createdAt: valid.workspace.createdAt,
            updatedAt: valid.workspace.updatedAt
          }
        ]
      }),
      JSON.stringify({
        ...valid,
        approvals: [
          {
            id: "approval-dangling",
            workspaceId: valid.workspace.id,
            runId: "missing-run",
            toolName: "post_webhook",
            args: {},
            status: "pending",
            createdAt: valid.workspace.createdAt
          }
        ]
      })
    ];

    for (const backup of invalidBackups) {
      await expect(
        restoreWorkspaceBackup(store, backup)
      ).rejects.toThrow("Backup file is invalid");
    }
    expect(await store.read((state) => state.workspace.name)).toBe(original);
    await store.close();
  });
});
