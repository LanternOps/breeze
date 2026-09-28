/**
 * Snapshot id ownership for brokered backup writes.
 *
 * Every snapshot id has exactly one owner row in
 * backup_snapshot_id_reservations, keyed by the id alone — independent of the
 * storage destination, its endpoint spelling and the organization — and a
 * deleted owner row leaves a tombstone, so an id is never handed out twice
 * (migrations/2026-11-08-120000 and 120100). For a brokered write the SERVER
 * issues the id (`mintSnapshotId`) and reserves it to the backup job before
 * the device receives it; the write session can then only ever presign keys
 * that parse as `snapshots/<that id>/…`.
 *
 * Lifecycle of a server-issued reservation:
 *   reserved  → the job's write sessions may upload under the prefix;
 *   sealing   → the snapshot row exists, but an upload URL issued without a
 *               create-only condition may still be usable (until sealed_until);
 *   published → no issued URL can change an object of the snapshot;
 *   abandoned → the job ended without publishing; storage reclaim may remove
 *               the prefix once it is old enough, which tombstones the id.
 * The database moves reserved → sealing/published when the snapshot row is
 * inserted (trigger); the cleanup job (jobs/backupWriteSessionJanitor.ts)
 * completes sealing and abandonment.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db';
import { backupSnapshotIdReservations, backupStorageSessions } from '../db/schema';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { parseBackupObjectKey } from './backupObjectKey';

/** The unique violation every ownership refusal is reported under. */
export const SNAPSHOT_ID_RESERVATION_CONSTRAINT = 'backup_snapshot_id_reservations_pkey';

/** Server-issued ids: the helper's `snapshot-<UTC>-<hex>` family, 24 hex of randomness. */
export const SERVER_SNAPSHOT_ID_PATTERN = /^snapshot-\d{8}T\d{6}Z-[0-9a-f]{24}$/;

const RANDOM_BYTES = 12;

function utcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * A new snapshot id: `snapshot-<yyyymmddThhmmssZ>-<24 lowercase hex>`. Same
 * family as the helper's own ids, so every parser and sorter of snapshot ids
 * keeps working; the random part makes it globally unique.
 */
export function mintSnapshotId(now: Date = new Date(), random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(RANDOM_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length < RANDOM_BYTES) {
    throw new Error('snapshot id random source returned too few bytes');
  }
  const id = `snapshot-${utcStamp(now)}-${bytes.subarray(0, RANDOM_BYTES).toString('hex')}`;
  if (parseBackupObjectKey(`snapshots/${id}/manifest.json`)?.snapshotId !== id) {
    throw new Error('minted snapshot id is not a valid object-key segment');
  }
  return id;
}

export function isServerMintedSnapshotId(id: unknown): id is string {
  return typeof id === 'string' && SERVER_SNAPSHOT_ID_PATTERN.test(id);
}

export type SnapshotIdReservation = typeof backupSnapshotIdReservations.$inferSelect;

/**
 * Reserves a freshly issued id to a backup job, in the caller's DB context
 * (the reservation's organization must be accessible there). The insert runs
 * in a savepoint so an id collision (another owner, or a tombstone) leaves
 * the caller's transaction usable; it is retried once with a new id.
 */
export async function reserveNewSnapshotId(
  input: { orgId: string; deviceId: string; configId: string; storageIdentity: string; jobId: string },
  opts: { now?: Date; random?: (n: number) => Buffer } = {},
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const snapshotId = mintSnapshotId(opts.now ?? new Date(), opts.random ?? randomBytes);
    try {
      await db.transaction((tx) =>
        tx.insert(backupSnapshotIdReservations).values({
          snapshotId,
          orgId: input.orgId,
          deviceId: input.deviceId,
          configId: input.configId,
          storageIdentity: input.storageIdentity,
          source: 'server_minted',
          state: 'reserved',
          currentJobId: input.jobId,
          writeGeneration: 1,
        }),
      );
      return snapshotId;
    } catch (err) {
      if (attempt >= 1 || !isPgUniqueViolation(err)) throw err;
    }
  }
}

/** The reservation a job is currently writing, if it has one (redelivery reuses it). */
export async function findReservedForJob(jobId: string): Promise<SnapshotIdReservation | null> {
  const [row] = await db
    .select()
    .from(backupSnapshotIdReservations)
    .where(and(
      eq(backupSnapshotIdReservations.currentJobId, jobId),
      eq(backupSnapshotIdReservations.state, 'reserved'),
      eq(backupSnapshotIdReservations.source, 'server_minted'),
    ))
    .orderBy(desc(backupSnapshotIdReservations.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The snapshot ids a job's write sessions were allowed to produce: every
 * reservation one of its write sessions holds, except one it gave up by
 * resuming onto another id. Null when the job never had a write session (an
 * unbrokered backup, which reports whatever id its helper chose).
 */
export async function allowedSnapshotIdsForJob(jobId: string): Promise<string[] | null> {
  const sessions = await db
    .select({ reservationSnapshotId: backupStorageSessions.reservationSnapshotId })
    .from(backupStorageSessions)
    .where(and(eq(backupStorageSessions.jobId, jobId), eq(backupStorageSessions.scope, 'snapshot_write')));
  const ids = [...new Set(sessions.map((s) => s.reservationSnapshotId).filter((v): v is string => !!v))];
  if (ids.length === 0) return null;
  const live = await db
    .select({ snapshotId: backupSnapshotIdReservations.snapshotId })
    .from(backupSnapshotIdReservations)
    .where(and(
      inArray(backupSnapshotIdReservations.snapshotId, ids),
      ne(backupSnapshotIdReservations.state, 'abandoned'),
    ));
  return live.map((r) => r.snapshotId);
}

/** Loads one reservation, optionally locking it for the rest of the caller's transaction. */
export async function loadReservation(
  snapshotId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<SnapshotIdReservation | null> {
  const query = db
    .select()
    .from(backupSnapshotIdReservations)
    .where(eq(backupSnapshotIdReservations.snapshotId, snapshotId))
    .limit(1);
  const [row] = opts.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}
