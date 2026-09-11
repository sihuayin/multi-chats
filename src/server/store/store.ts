import type { AppState } from "@/server/domain/types";

export interface StateStore {
  read<T>(reader: (state: Readonly<AppState>) => T | Promise<T>): Promise<T>;
  update<T>(
    updater: (state: AppState) => T | Promise<T>
  ): Promise<T>;
  migrate?(): Promise<void>;
  close?(): Promise<void>;
}
