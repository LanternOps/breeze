import { evaluateCapability, partnerIdForDevice, partnerIdForOrg, isLifecycleCommand, unresolvedPartnerDecision, type TrustDenyCode } from './partnerTrust';
import { partnerTrustMode } from '../config/partnerTrustMode';

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
