import { promotePendingAgentCredentials } from '../../services/agentTokenPromotion';
import { implicitPromotionTokenHash, shouldRotateAgentToken } from './heartbeatTokenRotation';

/**
 * Credential maintenance signals the heartbeat hands the agent: certificate
 * renewal, token rotation, and finishing a staged rotation. Shared by the main
 * heartbeat and the minimal parked beat (./heartbeatParked.ts) so both compute
 * the signals the same way — credential rotation is the one thing a parked
 * device still receives.
 */
export interface CredentialMaintenanceDevice {
  id: string;
  mtlsCertIssuedAt: Date | null;
  mtlsCertExpiresAt: Date | null;
  agentTokenHash: string | null;
  pendingTokenHash: string | null;
  pendingTokenExpiresAt: Date | null;
  pendingWatchdogTokenHash: string | null;
  pendingHelperTokenHash: string | null;
  watchdogTokenHash: string | null;
  helperTokenHash: string | null;
  tokenIssuedAt: Date | null;
}

export interface CredentialMaintenanceInput {
  device: CredentialMaintenanceDevice;
  now?: Date;
  /** `agent.tenantDraining` — an offboarding tenant may not mint (#3997). */
  tenantDraining: boolean;
  /** `agentTokenRotationRequired` — the caller used the superseded token. */
  authenticatedWithPreviousToken: boolean;
  /** `agentPendingTokenPresented` — the caller used the staged token (#2621). */
  pendingTokenPresented: boolean;
  /** Hash of the token the caller authenticated with (`agent.authTokenHash`). */
  presentedTokenHash: string | undefined;
}

export interface CredentialMaintenance {
  renewCert?: true;
  rotateToken?: true;
  confirmTokenRotation?: true;
}

/** Renew once two thirds of the certificate lifetime has elapsed. */
export function shouldRenewCert(
  device: Pick<CredentialMaintenanceDevice, 'mtlsCertIssuedAt' | 'mtlsCertExpiresAt'>,
  now: Date = new Date(),
): boolean {
  if (!device.mtlsCertExpiresAt || !device.mtlsCertIssuedAt) return false;
  const issuedMs = device.mtlsCertIssuedAt.getTime();
  const expiresMs = device.mtlsCertExpiresAt.getTime();
  const renewalThreshold = issuedMs + ((expiresMs - issuedMs) * 2) / 3;
  return now.getTime() >= renewalThreshold;
}

export async function computeCredentialMaintenance(
  input: CredentialMaintenanceInput,
): Promise<CredentialMaintenance> {
  const { device, tenantDraining, authenticatedWithPreviousToken, pendingTokenPresented, presentedTokenHash } = input;
  const now = input.now ?? new Date();

  const renewCert = shouldRenewCert(device, now);

  // Issue #2621 — a staged rotation is still outstanding. Don't ask for another
  // one (that would churn the staged set and re-open the divergence window);
  // ask the agent to finish the one it has. This is also the recovery path for
  // an agent that persisted the new credentials and then crashed before
  // confirming: it reconnects on the staged token and gets told to confirm.
  let pendingRotationLive =
    !!device.pendingTokenHash &&
    !!device.pendingTokenExpiresAt &&
    device.pendingTokenExpiresAt > now;

  // Issue #2621 — IMPLICIT PROMOTION. The agent is authenticating with the
  // staged credential, which is the same proof of durable possession that
  // /rotate-token/confirm requires, so promote it here too.
  //
  // This is what keeps PRE-#2621 agents alive. An old agent overwrites its own
  // token file on rotation and never calls confirm; without this it would run on
  // the pending hash until the staging window closed and then be locked out
  // permanently, with no way to self-heal (rotateToken is suppressed while a
  // rotation is staged, and after expiry it can no longer authenticate at all).
  // It also backstops a current agent whose confirm response was lost in flight.
  //
  // #2773 — bind the promotion to the hash the caller AUTHENTICATED with, not
  // to this handler's re-read of `pendingTokenHash`: see
  // implicitPromotionTokenHash for how the re-read strands the endpoint.
  const implicitPromotionHash = implicitPromotionTokenHash({
    pendingRotationLive,
    pendingTokenPresented,
    presentedTokenHash,
    devicePendingTokenHash: device.pendingTokenHash,
    deviceAgentTokenHash: device.agentTokenHash,
  });
  if (implicitPromotionHash && device.agentTokenHash) {
    try {
      const promoted = await promotePendingAgentCredentials({
        deviceId: device.id,
        pendingTokenHash: implicitPromotionHash,
        expectedAgentTokenHash: device.agentTokenHash,
        pendingWatchdogTokenHash: device.pendingWatchdogTokenHash,
        pendingHelperTokenHash: device.pendingHelperTokenHash,
        watchdogTokenHash: device.watchdogTokenHash,
        helperTokenHash: device.helperTokenHash,
      });
      if (promoted) {
        pendingRotationLive = false;
      }
    } catch (err) {
      // Best-effort: the staged credential still authenticates for the rest of
      // its window, and confirm/the next heartbeat will retry the promotion.
      console.error('[heartbeat] implicit pending-rotation promotion failed:', err);
    }
  }

  // #3997 — do not ASK for a rotation the mint route will now refuse.
  // `rotate-token` is off the tenant drain surface (agentAuth's
  // TENANT_DRAIN_ALLOWED_ACTIONS) and the route itself fails closed on a
  // drain, so signalling it here would have every agent in an offboarding
  // tenant attempt a mint it cannot complete on EVERY heartbeat for the whole
  // window (OFFBOARDING_DRAIN_WINDOW_HOURS, 72h by default), logging a rotation
  // failure each time. Suppressing the signal changes nothing about safety —
  // `handleTokenRotation` in agent/internal/heartbeat logs and returns, never
  // gating the heartbeat or touching on-disk credentials — it only stops a
  // guaranteed-useless round trip and its error noise.
  //
  // Only the TENANT drain is checked: `deviceUninstallDraining` returns from
  // the minimal drain beat at the top of the heartbeat handler and never
  // reaches here, so testing it too would be unreachable code.
  const rotateToken = shouldRotateAgentToken({
    tenantDraining,
    authenticatedWithPreviousToken,
    pendingRotationLive,
    watchdogTokenHash: device.watchdogTokenHash,
    tokenIssuedAt: device.tokenIssuedAt,
    now,
  });

  // Issue #2621 — set when the caller authenticated with the STAGED
  // credential, i.e. it demonstrably holds the new token but never
  // confirmed. Tells the agent to call /rotate-token/confirm and finish.
  const confirmTokenRotation = pendingRotationLive && pendingTokenPresented;

  return {
    ...(renewCert ? { renewCert: true as const } : {}),
    ...(rotateToken ? { rotateToken: true as const } : {}),
    ...(confirmTokenRotation ? { confirmTokenRotation: true as const } : {}),
  };
}
