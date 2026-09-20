import {
  createEgressClient,
  type EgressClient
} from "@/server/adapters/http/egress-client";
import {
  EMPTY_EGRESS_POLICY,
  type EgressPolicy
} from "@/server/security/egress-policy";

/**
 * The Workspace's egress policy.
 *
 * The Workspace does not carry one yet, so every Workspace denies the private
 * space — exactly what the previous hostname guard did. Putting the allowlist
 * into Workspace state is the registry ticket's work; this is the one place
 * that changes when it lands.
 */
export function workspaceEgressPolicy(): EgressPolicy {
  return EMPTY_EGRESS_POLICY;
}

/** The single outbound HTTP path: every Tool call and Source fetch goes here. */
export function createWorkspaceEgressClient(): EgressClient {
  return createEgressClient({
    resolvePolicy: () => workspaceEgressPolicy()
  });
}
