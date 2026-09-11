import { ConversationRunService } from "@/server/application/conversation-run-service";
import {
  FakeAgentEngine,
  PiAgentEngine
} from "@/server/application/agent-engine";
import { logger } from "@/server/observability/logger";
import { createCredentialCipher } from "@/server/security/credential-cipher";
import { getStore } from "@/server/store";

async function main(): Promise<void> {
  const store = getStore();
  const runs = new ConversationRunService(
    store,
    createCredentialCipher(),
    process.env.MODEL_MODE === "fake"
      ? new FakeAgentEngine()
      : new PiAgentEngine()
  );
  await runs.recoverInterruptedRuns();

  const interval = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
  let stopping = false;
  const shutdown = () => {
    stopping = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("worker.started", {
    pollIntervalMs: interval,
    modelMode: process.env.MODEL_MODE ?? "pi"
  });
  while (!stopping) {
    await store.update((state) => {
      state.workspace.workerHeartbeatAt = new Date().toISOString();
    });
    const processed = await runs.processNextQueuedRun();
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  if ("close" in store && typeof store.close === "function") {
    await store.close();
  }
  logger.info("worker.stopped");
}

main().catch((error) => {
  logger.error("worker.failed", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
