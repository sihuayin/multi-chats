import { getStore } from "@/server/store";

async function main(): Promise<void> {
  const store = getStore();
  await store.migrate?.();
  await store.close?.();
  console.log(
    process.env.DATABASE_URL
      ? "PostgreSQL migration complete"
      : `SQLite migration complete: ${
          process.env.SQLITE_PATH ?? ".data/multi-chats.sqlite"
        }`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
