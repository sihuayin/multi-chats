import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppState } from "@/server/domain/types";
import { createInitialState } from "@/server/store/initial-state";
import { migrateAppState } from "@/server/store/migrations";
import type { StateStore } from "@/server/store/store";

const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export class SqliteStore implements StateStore {
  private readonly database: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.database.exec("PRAGMA journal_mode = WAL");
    }
    this.migrateSync();
  }

  async migrate(): Promise<void> {
    this.migrateSync();
  }

  async read<T>(reader: (state: Readonly<AppState>) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => reader(structuredClone(this.loadState())));
  }

  async update<T>(updater: (state: AppState) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const state = this.loadState();
        const result = await updater(state);
        this.database
          .prepare(
            "UPDATE app_state SET state = ?, updated_at = ? WHERE workspace_id = ?"
          )
          .run(
            JSON.stringify(state),
            new Date().toISOString(),
            state.workspace.id
          );
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.queue;
    this.database.close();
  }

  private migrateSync(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        workspace_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.database
      .prepare(
        `
          INSERT INTO app_state (workspace_id, state, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT (workspace_id) DO NOTHING
        `
      )
      .run(
        DEFAULT_WORKSPACE_ID,
        JSON.stringify(createInitialState(DEFAULT_WORKSPACE_ID)),
        new Date().toISOString()
      );
    const migrated = this.loadState();
    this.database
      .prepare(
        "UPDATE app_state SET state = ?, updated_at = ? WHERE workspace_id = ?"
      )
      .run(
        JSON.stringify(migrated),
        new Date().toISOString(),
        migrated.workspace.id
      );
  }

  private loadState(): AppState {
    const row = this.database
      .prepare(
        "SELECT state FROM app_state ORDER BY updated_at DESC LIMIT 1"
      )
      .get() as { state?: string } | undefined;
    if (!row?.state) {
      throw new Error("SQLite Workspace state is not initialized");
    }
    return migrateAppState(JSON.parse(row.state));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
