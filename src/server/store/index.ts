import { MemoryStore } from "@/server/store/memory-store";
import { PostgresStore } from "@/server/store/postgres-store";
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
      : new MemoryStore();
  }
  return globalState.__multiChatsStore;
}

export function setStoreForTests(store: StateStore): void {
  (globalThis as StoreGlobal).__multiChatsStore = store;
}
