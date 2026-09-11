import { writeFile } from "node:fs/promises";
import { getStore } from "@/server/store";

async function main(): Promise<void> {
  const output = process.argv[2] ?? `multi-chats-backup-${Date.now()}.json`;
  const store = getStore();
  const state = await store.read((current) => current);
  await writeFile(output, JSON.stringify(state, null, 2), "utf8");
  await store.close?.();
  console.log(`Backup written to ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
