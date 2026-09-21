import { ConversationRunService } from "@/server/application/conversation-run-service";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import { createWorkspaceEgressClient } from "@/server/application/egress-policy-source";
import { SourceService } from "@/server/application/source-service";
import { DefaultTextExtractor } from "@/server/application/text-extractor";
import { extractPdfText } from "@/server/application/pdf-extractor";
import {
  createModelGateway
} from "@/server/adapters/model/model-gateway";
import { resolveModelContext } from "@/server/adapters/model/provider-registry";
import { logger } from "@/server/observability/logger";
import { createCredentialCipher } from "@/server/security/credential-cipher";
import { getStore } from "@/server/store";

async function main(): Promise<void> {
  const store = getStore();
  const runs = new ConversationRunService(
    store,
    createCredentialCipher(),
    createModelGateway(),
    {
      modelContext: ({ provider, modelId }) =>
        resolveModelContext(provider, modelId)
    }
  );
  const discussions = new DiscussionOrchestrator(store, runs);
  const sources = new SourceService(
    store,
    new DefaultTextExtractor({
      pdfToText: extractPdfText,
      fetchImpl: createWorkspaceEgressClient(store)
    })
  );
  await runs.recoverInterruptedRuns();
  await discussions.reconcileDiscussions();
  await sources.ingestPendingSources();

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
    await sources.ingestPendingSources();
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
