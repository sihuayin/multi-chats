import { PostgresStore } from "@/server/store/postgres-store";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const store = new PostgresStore(databaseUrl);
  await store.migrate();
  await store.close();
  console.log("Database migration complete");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
