import type { AppState } from "@/server/domain/types";
import {
  createEgressClient,
  type EgressClient
} from "@/server/adapters/http/egress-client";
import type { EgressPolicy } from "@/server/security/egress-policy";
import type { StateStore } from "@/server/store/store";

/**
 * The Workspace's egress policy.
 *
 * A Workspace is closed by default: public hosts are reachable without being
 * listed, and the private space is denied until the operator lists a host.
 */
export function workspaceEgressPolicy(
  state: Readonly<AppState>
): EgressPolicy {
  return { allowedHosts: state.workspace.egressAllowlist ?? [] };
}

/** The single outbound HTTP path: every Tool call and Source fetch goes here. */
export function createWorkspaceEgressClient(store: StateStore): EgressClient {
  return createEgressClient({
    // Read per request, so an allowlist edit takes effect at once.
    resolvePolicy: () => store.read((state) => workspaceEgressPolicy(state))
  });
}
