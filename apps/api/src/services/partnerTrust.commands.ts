import { evaluateCapability, partnerIdForDevice, isLifecycleCommand, unresolvedPartnerDecision, type TrustDenyCode } from './partnerTrust';
import { partnerTrustMode } from '../config/partnerTrustMode';

export class TrustDeniedError extends Error {
  readonly code: TrustDenyCode; readonly capability = 'device_execute' as const; readonly reason: string; readonly deviceId: string; readonly commandType: string;
  constructor(code: TrustDenyCode, reason: string, deviceId: string, commandType: string) {
    super(`Partner trust ${code}: ${commandType} on ${deviceId} (${reason})`);
    this.name = 'TrustDeniedError'; this.code = code; this.reason = reason; this.deviceId = deviceId; this.commandType = commandType;
  }
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
