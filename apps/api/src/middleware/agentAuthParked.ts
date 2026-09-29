import { CORE_AGENT_ACTION_INDEX, isCoreAgentPath } from './agentCorePath';

/**
 * Pre-assignment admission for agent routes.
 *
 * A device parked in its partner's holding org (`organizations.type =
 * 'unassigned_pool'`) keeps credential rotation and lifecycle removal, and
 * nothing else. This is a POSITIVE list, deny-by-default: an agent route added
 * later is refused for a parked device until someone adds it here on purpose
 * (and classifies it in routes/agents/parkedRouteClassification.test.ts, which
 * fails on any unclassified route).
 *
 * Why each entry exists:
 * - `heartbeat`: liveness, and the carrier of the rotation signals
 *   (renewCert / rotateToken / confirmTokenRotation). A parked device gets a
 *   minimal beat (routes/agents/heartbeatParked.ts), never the full one.
 * - `rotate-token`, `rotate-token/confirm`: token rotation (ruled in).
 * - `commands`, `commands/<commandId>/result`: poll and ack for lifecycle
 *   removal only — the claim allowlist on the agent context narrows both to
 *   `self_uninstall`.
 * - `uninstall-intent`: the agent reporting its own removal (a timestamp write
 *   on its own row).
 *
 * Certificate renewal (`/renew-cert*`, routes/agents/mtls.ts) authenticates
 * outside agentAuthMiddleware by design (AGENT_AUTH_SKIP_ID_SEGMENTS) and is
 * not on this list; it stays available to a parked device and issues nothing
 * but a certificate. The agent WebSocket and the Helper token authenticate
 * separately too, and refuse a parked device themselves.
 *
 * Anchored absolutely (see ./agentCorePath.ts): extension and Workspace agent
 * routes run through the same middleware at other mounts and never match.
 */
export const PARKED_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'heartbeat',
  'commands',
  'rotate-token',
  'uninstall-intent',
]);

/** The deny body every refused route returns for a parked device. */
export const PARKED_DEVICE_REFUSAL = { error: 'device_pending_assignment' } as const;

export function isParkedAllowedAgentPath(pathSegments: string[], agentId: string): boolean {
  // /api/v1/agents/<agentId>/<action>
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 1)
    && PARKED_ALLOWED_ACTIONS.has(pathSegments[CORE_AGENT_ACTION_INDEX] ?? '')
  ) {
    return true;
  }
  // /api/v1/agents/<agentId>/rotate-token/confirm
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 2)
    && pathSegments[CORE_AGENT_ACTION_INDEX] === 'rotate-token'
    && pathSegments[CORE_AGENT_ACTION_INDEX + 1] === 'confirm'
  ) {
    return true;
  }
  // /api/v1/agents/<agentId>/commands/<commandId>/result
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 3)
    && pathSegments[CORE_AGENT_ACTION_INDEX] === 'commands'
    && pathSegments[CORE_AGENT_ACTION_INDEX + 2] === 'result'
  ) {
    return true;
  }
  return false;
}
