import { isAgentTokenRotationDue } from '../../middleware/agentAuth';

/**
 * Pure decision: should this heartbeat response ask the agent to rotate its
 * credential set (`rotateToken: true`)? Split out of heartbeat.ts (which
 * pulls in the full db/schema import graph and is impractical to unit-test
 * in isolation) so this one decision is independently testable — in
 * particular the self-heal case that fires after an admin-triggered
 * `POST /devices/:id/agent-token/rotate` nulls the device's live
 * watchdog/helper hashes (`routes/devices/core.ts`): `!watchdogTokenHash`
 * alone is enough to ask for a rotation regardless of
 * `isAgentTokenRotationDue`, and the agent's own `/rotate-token` (staging)
 * and `/rotate-token/confirm` (promotion, `agentTokenPromotion.ts`) always
 * mint and promote fresh watchdog AND helper hashes together — there is no
 * path that rotates one role without the other.
 */
export function shouldRotateAgentToken(params: {
  tenantDraining: boolean;
  authenticatedWithPreviousToken: boolean;
  pendingRotationLive: boolean;
  watchdogTokenHash: string | null | undefined;
  tokenIssuedAt: Date | null | undefined;
}): boolean {
  return (
    !params.tenantDraining &&
    !params.authenticatedWithPreviousToken &&
    !params.pendingRotationLive &&
    (!params.watchdogTokenHash || isAgentTokenRotationDue(params.tokenIssuedAt))
  );
}
