import type { AppState } from "@/server/domain/types";
import { createInitialState } from "@/server/store/initial-state";
import type { StateStore } from "@/server/store/store";

export class MemoryStore implements StateStore {
  private state: AppState;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(initialState: AppState = createInitialState("00000000-0000-4000-8000-000000000001")) {
    this.state = structuredClone(initialState);
  }

  async read<T>(reader: (state: Readonly<AppState>) => T | Promise<T>): Promise<T> {
    return reader(structuredClone(this.state));
  }

  async update<T>(updater: (state: AppState) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await updater(draft);
      this.state = draft;
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  snapshot(): AppState {
    return structuredClone(this.state);
  }
}
