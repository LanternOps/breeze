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

/**
 * Issue #2773 — which staged hash (if any) the heartbeat may IMPLICITLY promote.
 *
 * The evidence for promotion is that the endpoint presented the staged token.
 * agentAuth established that against the row IT read; the heartbeat handler
 * re-reads the row afterwards. Binding the promotion to the re-read
 * `pendingTokenHash` let a re-stage that landed between those two reads get
 * promoted on evidence that belonged to a DIFFERENT credential — making
 * current a token the endpoint never held and demoting the one it does, which
 * strands it once the previous-token grace lapses. The promoted hash must be
 * the one the caller authenticated with, and it must still be the live staged
 * hash; `promotePendingAgentCredentials` then re-asserts both in its CAS.
 *
 * Returns the hash to promote, or null when there is nothing safe to promote.
 */
export function implicitPromotionTokenHash(params: {
  pendingRotationLive: boolean;
  pendingTokenPresented: boolean;
  presentedTokenHash: string | undefined;
  devicePendingTokenHash: string | null | undefined;
  deviceAgentTokenHash: string | null | undefined;
}): string | null {
  const {
    pendingRotationLive,
    pendingTokenPresented,
    presentedTokenHash,
    devicePendingTokenHash,
    deviceAgentTokenHash,
  } = params;
  if (!pendingRotationLive || !pendingTokenPresented) return null;
  if (!presentedTokenHash || !deviceAgentTokenHash || !devicePendingTokenHash) return null;
  if (devicePendingTokenHash !== presentedTokenHash) return null;
  return presentedTokenHash;
}
