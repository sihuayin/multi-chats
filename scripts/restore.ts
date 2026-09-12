import { readFile } from "node:fs/promises";
import { restoreWorkspaceBackup } from "@/server/application/backup-service";
import { getStore } from "@/server/store";

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) throw new Error("Backup file path is required");
  const store = getStore();
  await restoreWorkspaceBackup(store, await readFile(input, "utf8"));
  await store.close?.();
  console.log(`Backup restored from ${input}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
