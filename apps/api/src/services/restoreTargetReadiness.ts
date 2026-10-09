/**
 * Whether the device that would run a restore command can accept it now,
 * checked the same way the enqueue path checks it (offline devices and
 * helpers that do not check attestations are refused when the command is
 * queued). Used before a step-up grant is consumed, so a restore that would
 * be refused anyway burns no grant and records no authorization.
 *
 * Runs in the caller's DB context (RLS applies).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema/devices';
import { restoreIntegrityHelperRefusal } from './backupRestoreGate';

export async function restoreTargetRefusal(
  executingDeviceId: string,
  commandType: string,
): Promise<{ code: 'device_not_found' | 'device_offline' | 'backup_helper_update_required'; message: string } | null> {
  const [device] = await db
    .select({ status: devices.status, backupIntegrityProtocolVersion: devices.backupIntegrityProtocolVersion })
    .from(devices)
    .where(eq(devices.id, executingDeviceId))
    .limit(1);
  if (!device) return { code: 'device_not_found', message: 'Device not found' };
  if (device.status !== 'online') {
    return { code: 'device_offline', message: `Device is ${device.status}, cannot execute command` };
  }
  const helper = restoreIntegrityHelperRefusal(commandType, device.backupIntegrityProtocolVersion);
  return helper ? { code: 'backup_helper_update_required', message: helper } : null;
}
