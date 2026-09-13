import { Pool, type PoolClient } from "pg";
import type { AppState } from "@/server/domain/types";
import { createInitialState } from "@/server/store/initial-state";
import { migrateAppState } from "@/server/store/migrations";
import type { StateStore } from "@/server/store/store";

const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

export class PostgresStore implements StateStore {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        workspace_id uuid PRIMARY KEY,
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await this.pool.query(
      `
        INSERT INTO app_state (workspace_id, state)
        VALUES ($1, $2::jsonb)
        ON CONFLICT (workspace_id) DO NOTHING
      `,
      [DEFAULT_WORKSPACE_ID, JSON.stringify(createInitialState(DEFAULT_WORKSPACE_ID))]
    );
    const state = await this.load();
    await this.pool.query(
      "UPDATE app_state SET state = $2::jsonb, updated_at = now() WHERE workspace_id = $1",
      [state.workspace.id, JSON.stringify(state)]
    );
  }

  async read<T>(reader: (state: Readonly<AppState>) => T | Promise<T>): Promise<T> {
    const state = await this.load();
    return reader(structuredClone(state));
  }

  async update<T>(updater: (state: AppState) => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await this.load(client);
      const result = await updater(state);
      await client.query(
        "UPDATE app_state SET state = $2::jsonb, updated_at = now() WHERE workspace_id = $1",
        [state.workspace.id, JSON.stringify(state)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async load(client?: PoolClient): Promise<AppState> {
    const query =
      "SELECT state FROM app_state ORDER BY updated_at LIMIT 1" +
      (client ? " FOR UPDATE" : "");
    const result = await (client ?? this.pool).query<{ state: AppState }>(query);
    const state = result.rows[0]?.state;
    if (!state) {
      throw new Error("Workspace state is not initialized. Run migrations first.");
    }
    return migrateAppState(state);
  }
}
