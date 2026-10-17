import { sql, type SQL } from 'drizzle-orm';

/**
 * The device's current ownership epoch, as an SQL expression for an insert
 * value (PAM ownership epochs W2, #8204).
 *
 * `elevation_requests.device_epoch` must name the epoch the device is in when
 * the row is written. Reading it inside the INSERT itself keeps the value and
 * the write in one statement; `breeze_pam_chain_epoch_guard` then re-reads the
 * device FOR SHARE and refuses the row (23514) if the org or epoch do not
 * match, so a move racing the insert fails it rather than mis-anchoring it.
 */
export function currentOwnershipEpochSql(deviceId: string): SQL<number> {
  return sql<number>`(SELECT d.ownership_epoch FROM devices d WHERE d.id = ${deviceId}::uuid)`;
}
