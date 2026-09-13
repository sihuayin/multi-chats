import {
  createModelGateway
} from "@/server/adapters/model/model-gateway.server";
import { piProviderRegistry } from "@/server/adapters/model/provider-registry.server";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { DiscussionOrchestrator } from "@/server/application/discussion-orchestrator";
import { WorkspaceService } from "@/server/application/workspace-service";
import { createCredentialCipher } from "@/server/security/credential-cipher";
import { getStore } from "@/server/store";

type ServicesGlobal = typeof globalThis & {
  __multiChatsServices?: AppServices;
};

export type AppServices = {
  workspace: WorkspaceService;
  runs: ConversationRunService;
  discussions: DiscussionOrchestrator;
};

export function getServices(): AppServices {
  const globalState = globalThis as ServicesGlobal;
  if (!globalState.__multiChatsServices) {
    const store = getStore();
    const cipher = createCredentialCipher();
    const runs = new ConversationRunService(
      store,
      cipher,
      createModelGateway()
    );
    globalState.__multiChatsServices = {
      workspace: new WorkspaceService(store, cipher, piProviderRegistry),
      runs,
      discussions: new DiscussionOrchestrator(store, runs)
    };
  }
  return globalState.__multiChatsServices;
}

export function setServicesForTests(
  services: AppServices | undefined
): void {
  (globalThis as ServicesGlobal).__multiChatsServices = services;
}
