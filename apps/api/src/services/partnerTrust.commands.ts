import { evaluateCapability, partnerIdForDevice, isLifecycleCommand, type TrustDenyCode } from './partnerTrust';

export class TrustDeniedError extends Error {
  readonly code: TrustDenyCode; readonly capability = 'device_execute' as const; readonly reason: string; readonly deviceId: string; readonly commandType: string;
  constructor(code: TrustDenyCode, reason: string, deviceId: string, commandType: string) {
    super(`Partner trust ${code}: ${commandType} on ${deviceId} (${reason})`);
    this.name = 'TrustDeniedError'; this.code = code; this.reason = reason; this.deviceId = deviceId; this.commandType = commandType;
  }
}

export async function assertDeviceExecuteAllowed(deviceId: string, commandType: string, userId?: string | null): Promise<void> {
  if (isLifecycleCommand(commandType)) return;
  const partnerId = await partnerIdForDevice(deviceId);
  if (!partnerId) return;
  const d = await evaluateCapability('device_execute', { partnerId, deviceId, userId: userId ?? undefined, commandType });
  if (!d.allow) throw new TrustDeniedError(d.code, d.reason, deviceId, commandType);
}
