import { readFile } from "node:fs/promises";
import type { AppState } from "@/server/domain/types";
import { PostgresStore } from "@/server/store/postgres-store";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const input = process.argv[2];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!input) throw new Error("Backup file path is required");
  const backup = JSON.parse(await readFile(input, "utf8")) as AppState;
  if (!backup.workspace?.id) throw new Error("Backup file is invalid");
  const store = new PostgresStore(databaseUrl);
  await store.migrate();
  await store.update((state) => {
    Object.assign(state, backup);
  });
  await store.close();
  console.log(`Backup restored from ${input}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
