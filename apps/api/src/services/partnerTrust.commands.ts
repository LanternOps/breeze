import {
  evaluateCapability,
  evaluateCapabilityContinuationForState,
  partnerIdForDevice,
  partnerIdForOrg,
  isLifecycleCommand,
  recordCapabilityDenial,
  recordUnresolvedPartnerDenial,
  unresolvedPartnerDecision,
  UNRESOLVED_PARTNER_DENIAL,
  type TrustDenyCode,
} from './partnerTrust';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { runAfterDbContextExit } from '../db';
import type { PartnerTrustState } from '../db/schema/orgs';

export class TrustDeniedError extends Error {
  readonly code: TrustDenyCode; readonly capability = 'device_execute' as const; readonly reason: string; readonly deviceId: string; readonly commandType: string;
  constructor(code: TrustDenyCode, reason: string, deviceId: string, commandType: string) {
    super(`Partner trust ${code}: ${commandType} on ${deviceId} (${reason})`);
    this.name = 'TrustDeniedError'; this.code = code; this.reason = reason; this.deviceId = deviceId; this.commandType = commandType;
  }
}

/**
 * Loop-invariant `device_execute` verdict for an ENTIRE organization.
 *
 * Trust is a property of the partner, and every device in an org shares that
 * org's partner, so a caller weighing many devices of one org against the same
 * command type gets the same answer for all of them. Evaluating per device
 * would open one system-context connection and write one denial audit row per
 * device — a pool-exhaustion hazard and audit spam on a read-only listing.
 * Callers apply the returned verdict to every device they were considering.
 */
export async function deviceExecuteAllowedForOrg(orgId: string, commandType: string, userId?: string | null): Promise<boolean> {
  if (partnerTrustMode() === 'off') return true;
  if (isLifecycleCommand(commandType)) return true;
  const partnerId = await partnerIdForOrg(orgId);
  if (!partnerId) return (await unresolvedPartnerDecision('device_execute')).allow;
  return (await evaluateCapability('device_execute', { partnerId, orgId, userId: userId ?? undefined, commandType })).allow;
}

export async function assertDeviceExecuteAllowed(deviceId: string, commandType: string, userId?: string | null): Promise<void> {
  if (partnerTrustMode() === 'off') return;
  if (isLifecycleCommand(commandType)) return;
  const partnerId = await partnerIdForDevice(deviceId);
  if (!partnerId) {
    const unresolved = await unresolvedPartnerDecision('device_execute');
    if (!unresolved.allow) throw new TrustDeniedError(unresolved.code, unresolved.reason, deviceId, commandType);
    return;
  }
  const d = await evaluateCapability('device_execute', { partnerId, deviceId, userId: userId ?? undefined, commandType });
  if (!d.allow) throw new TrustDeniedError(d.code, d.reason, deviceId, commandType);
}

/** The two facts the `device_execute` gate needs about a device's org. */
export type DeviceExecuteTrustSnapshot = {
  /** NULL when the org's partner cannot be resolved — denied as unresolved. */
  partnerId: string | null;
  /** NULL when the partner row does not exist — denied as unresolved. */
  trustState: PartnerTrustState | null;
};

/**
 * `assertDeviceExecuteAllowed` for a BATCH of commands to one device, for a
 * caller that is holding a transaction (the command claim).
 *
 * `assertDeviceExecuteAllowed` resolves the partner and reads its trust state
 * through the system-context readers in `partnerTrust.repo`, each of which
 * borrows a second pooled connection — and, on a denial, writes the audit row
 * on yet another. Called per command inside a claim transaction that is a
 * double-hold per command, which deadlocks the pool once concurrent claims
 * reach its size (#1105). This gate instead:
 *  - reads the trust snapshot ONCE, lazily, through `readSnapshot` (which the
 *    caller runs on its own transaction), and only if some command in the
 *    batch is actually gated;
 *  - defers the denial audit / auto-promotion side effects until the caller's
 *    transaction has settled (`runAfterDbContextExit`).
 *
 * Verdicts are identical: trust is a property of the partner and every command
 * in the batch targets the same device, so only the command type (lifecycle
 * exemption) varies. Throws `TrustDeniedError` on a denial. A `readSnapshot`
 * failure is rethrown as-is for every gated command — never an allow.
 */
export function createDeviceExecuteBatchGate(
  deviceId: string,
  readSnapshot: () => Promise<DeviceExecuteTrustSnapshot>,
): (commandType: string, userId?: string | null) => Promise<void> {
  let snapshot: Promise<DeviceExecuteTrustSnapshot> | null = null;
  return async (commandType, userId) => {
    const mode = partnerTrustMode();
    if (mode === 'off') return;
    if (isLifecycleCommand(commandType)) return;
    snapshot ??= readSnapshot();
    const { partnerId, trustState } = await snapshot;

    if (!partnerId) {
      runAfterDbContextExit('partnerTrust.unresolvedPartnerDenial', () =>
        recordUnresolvedPartnerDenial('device_execute', mode),
      );
      if (mode === 'enforce') {
        throw new TrustDeniedError(UNRESOLVED_PARTNER_DENIAL.code, UNRESOLVED_PARTNER_DENIAL.reason, deviceId, commandType);
      }
      return;
    }

    // Same audit context as `assertDeviceExecuteAllowed` (no orgId), so a
    // denial row reads the same whichever path wrote it.
    const ctx = { partnerId, deviceId, userId: userId ?? undefined, commandType };
    const decision = evaluateCapabilityContinuationForState(
      'device_execute',
      ctx,
      // probationEnrollments only matters for agent_enroll.
      trustState ? { trustState, probationEnrollments: 0 } : null,
    );
    const denial = decision.allow ? decision.shadowDenied : decision;
    if (denial) {
      const { code, reason } = denial;
      runAfterDbContextExit('partnerTrust.capabilityDenial', () =>
        recordCapabilityDenial('device_execute', ctx, { code, reason }, mode),
      );
    }
    if (!decision.allow) throw new TrustDeniedError(decision.code, decision.reason, deviceId, commandType);
  };
}
