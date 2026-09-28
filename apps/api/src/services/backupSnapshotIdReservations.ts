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
 *   abandoned → the job ended without publishing; a later job of the same
 *               device, configuration, destination and base may take it over
 *               (back to reserved) while it is young enough; storage reclaim
 *               may remove the prefix once it is old enough, which tombstones
 *               the id.
 * The database moves reserved → sealing/published when the snapshot row is
 * inserted (trigger); the cleanup job (jobs/backupWriteSessionJanitor.ts)
 * completes sealing and abandonment.
 */
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '../db';
import { backupJobs, backupSnapshotIdReservations, backupStorageSessionUploads, backupStorageSessions } from '../db/schema';
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
 * How long after the cleanup job abandons a job's reserved id a late result
 * or a storage reconcile for THAT job may still publish it (enforced by the
 * backup_snapshots insert trigger, migration 2026-11-08-120100, as
 * `interval '108 hours'`). Equal to storage reconcile's age limit for an
 * unclaimed manifest, and well inside the orphan window after which storage
 * reclaim may remove an abandoned prefix.
 */
export const ABANDONED_ADOPTION_WINDOW_MS = 108 * 60 * 60 * 1000;

/**
 * How old (from issue) an unfinished server-issued id may be for a LATER job
 * of the same device, configuration, destination and dispatched base to take
 * it over and continue writing it (backupStorageWriteSessions.ts,
 * decideResumeTarget). 108 hours, the same as the adoption window: shorter
 * than the helper's 7-day checkpoint-journal age, and more than two days
 * inside the 7-day floor below which storage reclaim never removes an
 * abandoned prefix — so a prefix being continued is never reclaimed under
 * the writer. Measured from the reservation's creation, so repeated takeovers
 * cannot keep an id alive past it.
 */
export const SNAPSHOT_TAKEOVER_MAX_AGE_MS = 108 * 60 * 60 * 1000;

/**
 * The snapshot ids a job's write sessions were allowed to produce: every
 * reservation one of its write sessions holds whose CURRENT job is this job
 * (after another job has taken an unfinished id over, the earlier job may no
 * longer publish it; an id given up by resuming onto another one has no job),
 * plus a sealing or published id one of its sessions resumed onto read-only
 * (it reports that published manifest). An id the cleanup job abandoned after
 * this job ended still counts — the database decides whether it is still
 * adoptable. Null when the job never had a write session (an unbrokered
 * backup, which reports whatever id its helper chose; the backup_snapshots
 * insert trigger still refuses a server-issued id reserved to another job).
 */
export async function allowedSnapshotIdsForJob(jobId: string): Promise<string[] | null> {
  const sessions = await db
    .select({ reservationSnapshotId: backupStorageSessions.reservationSnapshotId, readOnly: backupStorageSessions.readOnly })
    .from(backupStorageSessions)
    .where(and(eq(backupStorageSessions.jobId, jobId), eq(backupStorageSessions.scope, 'snapshot_write')));
  const ids = [...new Set(sessions.map((s) => s.reservationSnapshotId).filter((v): v is string => !!v))];
  if (ids.length === 0) return null;
  const readOnlyIds = [...new Set(sessions.filter((s) => s.readOnly).map((s) => s.reservationSnapshotId).filter((v): v is string => !!v))];
  const live = await db
    .select({ snapshotId: backupSnapshotIdReservations.snapshotId })
    .from(backupSnapshotIdReservations)
    .where(and(
      inArray(backupSnapshotIdReservations.snapshotId, ids),
      or(
        eq(backupSnapshotIdReservations.currentJobId, jobId),
        readOnlyIds.length > 0
          ? and(
            inArray(backupSnapshotIdReservations.snapshotId, readOnlyIds),
            inArray(backupSnapshotIdReservations.state, ['sealing', 'published']),
          )
          : sql`false`,
      ),
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

/**
 * For storage reconcile (system scope): which of these ids are reserved to
 * another organization, which server-issued ids are still being written or
 * sealed by a live backup job (never adoptable — the job's own result
 * publishes them), and, for each server-issued id, the job currently holding
 * it — the only job whose result may publish it (after a takeover, earlier
 * jobs still record the id but can no longer publish it).
 */
export async function loadSnapshotIdClaims(
  snapshotIds: string[],
  orgId: string,
): Promise<{ foreign: Set<string>; live: Set<string>; currentJobs: Map<string, string> }> {
  const foreign = new Set<string>();
  const live = new Set<string>();
  const currentJobs = new Map<string, string>();
  if (snapshotIds.length === 0) return { foreign, live, currentJobs };
  const rows = await db
    .select({
      snapshotId: backupSnapshotIdReservations.snapshotId,
      orgId: backupSnapshotIdReservations.orgId,
      state: backupSnapshotIdReservations.state,
      source: backupSnapshotIdReservations.source,
      currentJobId: backupSnapshotIdReservations.currentJobId,
      jobStatus: backupJobs.status,
    })
    .from(backupSnapshotIdReservations)
    .leftJoin(backupJobs, eq(backupJobs.id, backupSnapshotIdReservations.currentJobId))
    .where(inArray(backupSnapshotIdReservations.snapshotId, snapshotIds));
  for (const row of rows) {
    if (row.orgId !== orgId) foreign.add(row.snapshotId);
    // Only a server-issued id is written through a session; an id recorded
    // for an older helper's job keeps today's adoption rules.
    if (row.source === 'server_minted'
      && (row.state === 'reserved' || row.state === 'sealing')
      && (row.jobStatus === 'pending' || row.jobStatus === 'running')) {
      live.add(row.snapshotId);
    }
    if (row.source === 'server_minted' && row.currentJobId) currentJobs.set(row.snapshotId, row.currentJobId);
  }
  return { foreign, live, currentJobs };
}

// ── Storage reclaim (jobs/backupRetention.ts, system context) ──────────────

/**
 * What storage reclaim must leave alone this run, across EVERY organization
 * (the id is the owner key, not the destination): server-issued ids still
 * reserved or sealing, and ones abandoned more recently than
 * `abandonedGraceMs`. Also the abandoned ids old enough to reclaim, with the
 * storage identity they were issued for.
 *
 * Only server-issued reservations change reclaim: an id recorded for an
 * older helper's in-flight job keeps today's rules (the manifest-less window
 * already outlasts that helper's own resume window).
 */
export async function loadReservationGcState(
  nowMs: number,
  abandonedGraceMs: number,
): Promise<{ protectedIds: Set<string>; reclaimable: Array<{ snapshotId: string; storageIdentity: string }> }> {
  const rows = await db
    .select({
      snapshotId: backupSnapshotIdReservations.snapshotId,
      state: backupSnapshotIdReservations.state,
      storageIdentity: backupSnapshotIdReservations.storageIdentity,
      updatedAt: backupSnapshotIdReservations.updatedAt,
    })
    .from(backupSnapshotIdReservations)
    .where(and(
      eq(backupSnapshotIdReservations.source, 'server_minted'),
      inArray(backupSnapshotIdReservations.state, ['reserved', 'sealing', 'abandoned']),
    ));
  const protectedIds = new Set<string>();
  const reclaimable: Array<{ snapshotId: string; storageIdentity: string }> = [];
  for (const row of rows) {
    if (row.state !== 'abandoned' || nowMs - row.updatedAt.getTime() < abandonedGraceMs) {
      protectedIds.add(row.snapshotId);
    } else if (row.storageIdentity) {
      reclaimable.push({ snapshotId: row.snapshotId, storageIdentity: row.storageIdentity });
    }
  }
  return { protectedIds, reclaimable };
}

/**
 * Deletes abandoned reservations whose prefix storage reclaim has emptied,
 * re-checking at delete time that each is still abandoned with no live
 * session and no open upload. Each id is tombstoned `abandoned_reclaimed`
 * first (the delete trigger would otherwise record a generic reason).
 */
function idList(snapshotIds: string[]) {
  return sql.join(snapshotIds.map((id) => sql`${id}`), sql`, `);
}

export async function reclaimAbandonedReservations(snapshotIds: string[]): Promise<number> {
  if (snapshotIds.length === 0) return 0;
  const eligible = sql`
    r.snapshot_id IN (${idList(snapshotIds)})
    AND r.state = 'abandoned'
    AND NOT EXISTS (
      SELECT 1 FROM backup_storage_sessions s
       WHERE s.reservation_snapshot_id = r.snapshot_id AND s.revoked_at IS NULL AND s.expires_at > now())
    AND NOT EXISTS (
      SELECT 1 FROM backup_storage_session_uploads u
       WHERE u.reservation_snapshot_id = r.snapshot_id AND u.state IN ('creating', 'open', 'completing'))`;
  await db.execute(sql`
    INSERT INTO backup_snapshot_id_tombstones (snapshot_id, reason)
    SELECT r.snapshot_id, 'abandoned_reclaimed' FROM backup_snapshot_id_reservations r WHERE ${eligible}
    ON CONFLICT (snapshot_id) DO NOTHING`);
  const deleted = await db.execute(sql`
    DELETE FROM backup_snapshot_id_reservations r WHERE ${eligible} RETURNING r.snapshot_id`);
  return (deleted as unknown as unknown[]).length;
}

/** A snapshot row was retired and no row with its id remains: the id is retired. */
export async function markReservationRetired(snapshotId: string, orgId: string): Promise<void> {
  await db.execute(sql`
    UPDATE backup_snapshot_id_reservations r
       SET state = 'retired', updated_at = now()
     WHERE r.snapshot_id = ${snapshotId}
       AND r.org_id = ${orgId}
       AND r.state IN ('published', 'sealing')
       AND NOT EXISTS (SELECT 1 FROM backup_snapshots s WHERE s.snapshot_id = ${snapshotId})`);
}

/** Retired ids whose prefix storage reclaim confirmed gone: tombstoned, then deleted. */
export async function tombstoneRetiredReservations(snapshotIds: string[]): Promise<number> {
  if (snapshotIds.length === 0) return 0;
  await db.execute(sql`
    INSERT INTO backup_snapshot_id_tombstones (snapshot_id, reason)
    SELECT r.snapshot_id, 'retired' FROM backup_snapshot_id_reservations r
     WHERE r.snapshot_id IN (${idList(snapshotIds)}) AND r.state = 'retired'
    ON CONFLICT (snapshot_id) DO NOTHING`);
  const deleted = await db.execute(sql`
    DELETE FROM backup_snapshot_id_reservations r
     WHERE r.snapshot_id IN (${idList(snapshotIds)}) AND r.state = 'retired'
    RETURNING r.snapshot_id`);
  return (deleted as unknown as unknown[]).length;
}

/**
 * True while a brokered write of this snapshot id may still change its bytes:
 * the reservation is sealing (an issued upload URL may still be usable), or a
 * multipart completion or a delete through one of its sessions is in flight.
 * Readers of the snapshot's bytes — restores, attestation verification — wait
 * until it is false. Runs in the caller's DB context.
 */
export async function isSnapshotWriteInFlight(snapshotId: string): Promise<boolean> {
  const [reservation] = await db
    .select({ state: backupSnapshotIdReservations.state })
    .from(backupSnapshotIdReservations)
    .where(eq(backupSnapshotIdReservations.snapshotId, snapshotId))
    .limit(1);
  if (!reservation) return false;
  if (reservation.state === 'sealing') return true;
  const [deleting] = await db
    .select({ id: backupStorageSessions.id })
    .from(backupStorageSessions)
    .where(and(
      eq(backupStorageSessions.reservationSnapshotId, snapshotId),
      isNotNull(backupStorageSessions.deletingSince),
    ))
    .limit(1);
  if (deleting) return true;
  const [completing] = await db
    .select({ id: backupStorageSessionUploads.id })
    .from(backupStorageSessionUploads)
    .where(and(
      eq(backupStorageSessionUploads.reservationSnapshotId, snapshotId),
      eq(backupStorageSessionUploads.state, 'completing'),
    ))
    .limit(1);
  return !!completing;
}
