import { ConversationRunService } from "@/server/application/conversation-run-service";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import {
  createModelGateway
} from "@/server/adapters/model/model-gateway";
import { logger } from "@/server/observability/logger";
import { createCredentialCipher } from "@/server/security/credential-cipher";
import { getStore } from "@/server/store";

async function main(): Promise<void> {
  const store = getStore();
  const runs = new ConversationRunService(
    store,
    createCredentialCipher(),
    createModelGateway()
  );
  const discussions = new DiscussionOrchestrator(store, runs);
  await runs.recoverInterruptedRuns();
  await discussions.reconcileDiscussions();

  const interval = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1_000);
  let stopping = false;
  const shutdown = () => {
    stopping = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const writeHeartbeat = () =>
    store.update((state) => {
      state.workspace.workerHeartbeatAt = new Date().toISOString();
    });
  await writeHeartbeat();
  const heartbeatTimer = setInterval(() => {
    void writeHeartbeat().catch((error) => {
      logger.error("worker.heartbeat.failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }, 5_000);

  logger.info("worker.started", {
    pollIntervalMs: interval,
    modelMode: process.env.MODEL_MODE ?? "pi"
  });
  while (!stopping) {
    const processed = await runs.processNextQueuedRun();
    await discussions.reconcileDiscussions();
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  clearInterval(heartbeatTimer);
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
