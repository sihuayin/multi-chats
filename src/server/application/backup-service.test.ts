import { CURRENT_SCHEMA_VERSION } from "@/server/store/migrations";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspaceBackup,
  parseWorkspaceBackup,
  restoreWorkspaceBackup
} from "@/server/application/backup-service";
import { createInitialState } from "@/server/store/initial-state";
import { SqliteStore } from "@/server/store/sqlite-store";
import {
  createFixtureDiscussion,
  createFixtureState,
  addFixtureTaskRunCorrelation
} from "@/server/test-support/fixtures";

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
      const discussion = createFixtureDiscussion({
        workspaceId: state.workspace.id
      });
      state.discussions.push(discussion);
      state.artifacts.push({
        id: "artifact-discussion",
        workspaceId: state.workspace.id,
        ownerType: "discussion",
        ownerId: discussion.id,
        type: "json",
        name: "Discussion Brief",
        content: JSON.stringify({ recommendation: "Keep the state document." }),
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
    expect(await target.read((state) => state.discussions)).toContainEqual(
      expect.objectContaining({ id: "70000000-0000-4000-8000-000000000001" })
    );
    expect(await target.read((state) => state.artifacts)).toContainEqual(
      expect.objectContaining({
        id: "artifact-discussion",
        ownerType: "discussion",
        ownerId: "70000000-0000-4000-8000-000000000001"
      })
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
            ownerType: "task",
            ownerId: "task-invalid",
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
            ownerType: "task",
            ownerId: "missing-task",
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
      }),
      JSON.stringify({
        ...valid,
        discussions: [
          {
            ...createFixtureDiscussion({
              workspaceId: valid.workspace.id
            }),
            status: "unknown"
          }
        ]
      }),
      JSON.stringify({
        ...valid,
        artifacts: [
          {
            id: "artifact-missing-discussion",
            workspaceId: valid.workspace.id,
            ownerType: "discussion",
            ownerId: "missing-discussion",
            type: "text",
            name: "Dangling Discussion Artifact",
            content: "Missing Discussion",
            createdAt: valid.workspace.createdAt,
            updatedAt: valid.workspace.updatedAt
          }
        ]
      }),
      JSON.stringify({
        ...createFixtureState(),
        discussions: [
          {
            ...createFixtureDiscussion(),
            language: "fr"
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

  it("round-trips runtime contract ledgers without credentials", async () => {
    const store = new SqliteStore(":memory:");
    const state = createFixtureState();
    const provider = state.providers[0];
    const employee = state.employees[0];
    employee.fallbackTargets = [
      {
        providerCredentialId: provider.id,
        modelId: "fallback-model"
      }
    ];
    state.providerAttempts.push({
      id: "attempt-1",
      workspaceId: state.workspace.id,
      purpose: "discussion_turn",
      provider: provider.provider,
      modelId: employee.modelId,
      targetOrder: 0,
      attempt: 1,
      status: "succeeded",
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        source: "provider"
      },
      startedAt: state.workspace.createdAt,
      completedAt: state.workspace.updatedAt
    });
    state.modelPricing.push({
      id: "pricing-1",
      workspaceId: state.workspace.id,
      provider: provider.provider,
      modelId: employee.modelId,
      currency: "USD",
      inputMicrosPerMillionTokens: 1_000_000,
      outputMicrosPerMillionTokens: 2_000_000,
      effectiveAt: state.workspace.createdAt,
      source: "test",
      version: "1",
      createdAt: state.workspace.createdAt
    });
    const { task, message, run } = addFixtureTaskRunCorrelation(state);
    state.artifacts.push({
      id: "artifact-correlated",
      workspaceId: state.workspace.id,
      ownerType: "task",
      ownerId: task.id,
      runId: run.id,
      type: "json",
      name: "Task result",
      content: JSON.stringify({ complete: true }),
      createdAt: state.workspace.createdAt,
      updatedAt: state.workspace.updatedAt
    });

    const backup = JSON.stringify(state);
    await restoreWorkspaceBackup(store, backup);

    expect(await store.read((restored) => restored.providerAttempts)).toEqual(
      state.providerAttempts
    );
    expect(await store.read((restored) => restored.modelPricing)).toEqual(
      state.modelPricing
    );
    expect(await store.read((restored) => restored.employees[0].fallbackTargets))
      .toEqual(employee.fallbackTargets);
    expect(
      await store.read((restored) => ({
        task: restored.tasks.find((item) => item.id === task.id),
        message: restored.messages.find((item) => item.id === message.id),
        run: restored.runs.find((item) => item.id === run.id),
        artifact: restored.artifacts.find(
          (item) => item.id === "artifact-correlated"
        )
      }))
    ).toEqual({
      task,
      message,
      run,
      artifact: state.artifacts.find(
        (item) => item.id === "artifact-correlated"
      )
    });

    const invalid = structuredClone(state) as unknown as {
      providerAttempts: Array<Record<string, unknown>>;
    };
    invalid.providerAttempts[0].credential = "must-not-persist";
    expect(() => parseWorkspaceBackup(JSON.stringify(invalid))).toThrow(
      "Backup file is invalid"
    );
    await store.close();
  });

  it("migrates v2 backups before restore", () => {
    const legacy = createFixtureState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 2;
    for (const key of [
      "providerAttempts",
      "evidenceReferences",
      "discussionCompressions",
      "discussionInterventions",
      "discussionContextRevisions",
      "modelPricing"
    ]) {
      delete legacy[key];
    }

    expect(parseWorkspaceBackup(JSON.stringify(legacy))).toMatchObject({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      providerAttempts: [],
      evidenceReferences: [],
      discussionCompressions: [],
      discussionInterventions: [],
      discussionContextRevisions: [],
      modelPricing: []
    });
  });

  it("restores a backup taken before the Tool registry existed", () => {
    const legacy = createFixtureState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 5;
    delete legacy.tools;

    const restored = parseWorkspaceBackup(JSON.stringify(legacy));

    // It restores because the migration backfills the collection, not because
    // validation was loosened.
    expect(restored.tools).toHaveLength(5);
    expect(restored.workspace.egressAllowlist).toEqual([]);
  });
});
