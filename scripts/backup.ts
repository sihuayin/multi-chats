import { writeFile } from "node:fs/promises";
import { createWorkspaceBackup } from "@/server/application/backup-service";
import { getStore } from "@/server/store";

async function main(): Promise<void> {
  const output = process.argv[2] ?? `multi-chats-backup-${Date.now()}.json`;
  const store = getStore();
  const backup = await createWorkspaceBackup(store);
  await writeFile(output, backup, "utf8");
  await store.close?.();
  console.log(`Backup written to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
