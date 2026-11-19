import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { deviceRecoveryKeys } from '../../db/schema';

const MAX_ESCROWED_PROTECTORS = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** BitLocker reports a protector id as a braced uppercase GUID; the wire contract is a uuid. */
function protectorUuid(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
  return UUID.test(value) ? value : null;
}

/**
 * The device's active escrowed BitLocker recovery-password protector ids, for a
 * vendor update payload. Ids only: the key material stays in the vault, and the
 * agent uses these to confirm a recovery key for the volume's current protector
 * is already escrowed. Runs on the caller's context.
 */
export async function escrowedProtectorIds(deviceId: string): Promise<string[]> {
  const keys = await db
    .select({ protectorId: deviceRecoveryKeys.protectorId })
    .from(deviceRecoveryKeys)
    .where(and(
      eq(deviceRecoveryKeys.deviceId, deviceId),
      eq(deviceRecoveryKeys.status, 'active'),
      eq(deviceRecoveryKeys.keyType, 'bitlocker_recovery_password'),
    ))
    .limit(MAX_ESCROWED_PROTECTORS);
  return keys.flatMap(({ protectorId }) => protectorUuid(protectorId) ?? []);
}
