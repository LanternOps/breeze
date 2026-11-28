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
 * - `heartbeat`: liveness, and the carrier of the token rotation signals
 *   (rotateToken / confirmTokenRotation; never renewCert, see below). A parked
 *   device gets a minimal beat (routes/agents/heartbeatParked.ts), never the
 *   full one.
 * - `rotate-token`, `rotate-token/confirm`: token rotation (ruled in).
 * - `commands`, `commands/<commandId>/result`: poll and ack for lifecycle
 *   removal only — the claim allowlist on the agent context narrows both to
 *   `self_uninstall`.
 * - `uninstall-intent`: the agent reporting its own removal (a timestamp write
 *   on its own row).
 * - `rebind` (#8318 §6.3): phase 1 of a human-authorized reattach. A parked
 *   device is the typical SOURCE: a reinstalled machine that enrolled into the
 *   holding area and is being reattached onto its existing record. The route
 *   acts only on an intent naming this device as its source, and writes
 *   nothing to any device row. (`rebind-confirm` authenticates outside
 *   agentAuthMiddleware, with its confirm-only token.)
 * - `attestation/challenge`, `attestation/complete` (#8318 wave T2): the TPM
 *   key proof that lets a parked SOURCE carry `tpm_continuity` evidence. They
 *   write only this device's own device_hardware tpm_* columns (and audit),
 *   under its own row lock; the challenge is rate-limited per device. Note the
 *   exposure: a leaked deploy key enrolls parked devices that may now also
 *   plant a key baseline. A planted (software) key matches no existing
 *   record's baseline, so it gains no continuity; §9.3.
 *
 * Certificate renewal (`/renew-cert*`, routes/agents/mtls.ts) authenticates
 * outside agentAuthMiddleware by design (AGENT_AUTH_SKIP_ID_SEGMENTS) and is
 * not on this list; its own bearer check refuses a parked device with the
 * same body (#8318 spec §10.4: the certificate issued at pool enrollment
 * lives no longer than the parking window and is never renewed there). The
 * agent WebSocket and the Helper token authenticate separately too, and
 * refuse a parked device themselves.
 *
 * Anchored absolutely (see ./agentCorePath.ts): extension and Workspace agent
 * routes run through the same middleware at other mounts and never match.
 */
export const PARKED_ALLOWED_ACTIONS: ReadonlySet<string> = new Set([
  'heartbeat',
  'commands',
  'rotate-token',
  'uninstall-intent',
  'rebind',
]);

/** Two-segment actions a parked device may call, matched exactly (both segments). */
export const PARKED_ALLOWED_TWO_SEGMENT_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ['rotate-token', 'confirm'],
  ['attestation', 'challenge'],
  ['attestation', 'complete'],
];

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
  // /api/v1/agents/<agentId>/rotate-token/confirm,
  // /api/v1/agents/<agentId>/attestation/{challenge,complete}
  if (
    isCoreAgentPath(pathSegments, agentId, CORE_AGENT_ACTION_INDEX + 2)
    && PARKED_ALLOWED_TWO_SEGMENT_ACTIONS.some(([first, second]) =>
      pathSegments[CORE_AGENT_ACTION_INDEX] === first && pathSegments[CORE_AGENT_ACTION_INDEX + 1] === second)
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
