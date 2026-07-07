import { createHash } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { deviceRecoveryKeys } from '../db/schema';
import { encryptColumnValueForWrite } from './encryptedColumnRegistry';

export type IncomingRecoveryKey = {
  keyType: 'bitlocker_recovery_password' | 'filevault_personal_recovery_key';
  volumeMount?: string | null;
  protectorId?: string | null;
  recoveryKey: string;
};

export type EscrowStats = { inserted: number; superseded: number; unchanged: number };

export function fingerprintRecoveryKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

// One "slot" = (keyType, volumeMount). A device has at most one active key per
// slot; a changed fingerprint supersedes the old row (history retained).
function slotOf(keyType: string, volumeMount: string | null | undefined): string {
  return `${keyType}|${volumeMount ?? ''}`;
}

/**
 * Escrow a batch of recovery keys for a device.
 *
 * `source === 'snapshot'` means the batch is the device's FULL current set of
 * BitLocker keys: active bitlocker rows absent from the batch are superseded
 * (the protector no longer exists on the device). FileVault rows are exempt —
 * they are only written by the rotate command (`source === 'rotation'`),
 * which never snapshot-supersedes anything.
 */
export async function escrowRecoveryKeys(
  deviceId: string,
  orgId: string,
  source: 'snapshot' | 'rotation',
  keys: IncomingRecoveryKey[],
): Promise<EscrowStats> {
  const active = await db
    .select({
      id: deviceRecoveryKeys.id,
      keyType: deviceRecoveryKeys.keyType,
      volumeMount: deviceRecoveryKeys.volumeMount,
      keyFingerprint: deviceRecoveryKeys.keyFingerprint,
    })
    .from(deviceRecoveryKeys)
    .where(and(
      eq(deviceRecoveryKeys.deviceId, deviceId),
      eq(deviceRecoveryKeys.status, 'active'),
    ));

  const incomingBySlot = new Map<string, IncomingRecoveryKey>();
  for (const key of keys) {
    incomingBySlot.set(slotOf(key.keyType, key.volumeMount), key);
  }

  const toSupersede: string[] = [];
  let unchanged = 0;

  for (const row of active) {
    const slot = slotOf(row.keyType, row.volumeMount);
    const incoming = incomingBySlot.get(slot);
    if (incoming) {
      if (row.keyFingerprint === fingerprintRecoveryKey(incoming.recoveryKey)) {
        incomingBySlot.delete(slot);
        unchanged++;
      } else {
        toSupersede.push(row.id);
      }
    } else if (source === 'snapshot' && row.keyType === 'bitlocker_recovery_password') {
      toSupersede.push(row.id);
    }
  }

  if (toSupersede.length > 0) {
    await db
      .update(deviceRecoveryKeys)
      .set({ status: 'superseded', supersededAt: new Date(), updatedAt: new Date() })
      .where(inArray(deviceRecoveryKeys.id, toSupersede));
  }

  let inserted = 0;
  for (const key of incomingBySlot.values()) {
    await db.insert(deviceRecoveryKeys).values({
      deviceId,
      orgId,
      keyType: key.keyType,
      volumeMount: key.volumeMount ?? null,
      protectorId: key.protectorId ?? null,
      encryptedKey: encryptColumnValueForWrite('device_recovery_keys', 'encrypted_key', key.recoveryKey) as string,
      keyFingerprint: fingerprintRecoveryKey(key.recoveryKey),
      status: 'active',
    });
    inserted++;
  }

  return { inserted, superseded: toSupersede.length, unchanged };
}
