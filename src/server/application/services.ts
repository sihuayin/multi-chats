import {
  FakeEmployeeEngine,
  PiEmployeeEngine
} from "@/server/application/employee-engine";
import { ConversationRunService } from "@/server/application/conversation-run-service";
import { WorkspaceService } from "@/server/application/workspace-service";
import { createCredentialCipher } from "@/server/security/credential-cipher";
import { getStore } from "@/server/store";

type ServicesGlobal = typeof globalThis & {
  __multiChatsServices?: {
    workspace: WorkspaceService;
    runs: ConversationRunService;
  };
};

export function getServices() {
  const globalState = globalThis as ServicesGlobal;
  if (!globalState.__multiChatsServices) {
    const store = getStore();
    const cipher = createCredentialCipher();
    const engine =
      process.env.MODEL_MODE === "fake"
        ? new FakeEmployeeEngine()
        : new PiEmployeeEngine();
    globalState.__multiChatsServices = {
      workspace: new WorkspaceService(store, cipher),
      runs: new ConversationRunService(store, cipher, engine)
    };
  }
  return globalState.__multiChatsServices;
}
