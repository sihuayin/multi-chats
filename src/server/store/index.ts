import { PostgresStore } from "@/server/store/postgres-store";
import { SqliteStore } from "@/server/store/sqlite-store";
import type { StateStore } from "@/server/store/store";

type StoreGlobal = typeof globalThis & {
  __multiChatsStore?: StateStore;
};

export function getStore(): StateStore {
  const globalState = globalThis as StoreGlobal;
  if (!globalState.__multiChatsStore) {
    const databaseUrl = process.env.DATABASE_URL;
    globalState.__multiChatsStore = databaseUrl
      ? new PostgresStore(databaseUrl)
      : new SqliteStore(
          process.env.SQLITE_PATH ?? ".data/multi-chats.sqlite"
        );
  }
  return globalState.__multiChatsStore;
}

export function setStoreForTests(store: StateStore): void {
  (globalThis as StoreGlobal).__multiChatsStore = store;
}
