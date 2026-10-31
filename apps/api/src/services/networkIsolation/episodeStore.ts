import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import { RESOLVED_TERMINAL_STATES } from '@breeze/shared';
import { isPgUniqueViolation } from '@breeze/shared/pgErrors';
import type { db } from '../../db';
import {
  deviceNetworkIsolations,
  type DeviceNetworkIsolation,
  type NewDeviceNetworkIsolation,
} from '../../db/schema';
import type { EpisodeSnapshot } from './stateMachine';

/**
 * Persistence for network-isolation episodes (plan W1a Task 3). Every function runs inside the
 * caller's transaction (`withDbAccessContext` on the request path, `withSystemDbAccessContext` in
 * workers), so RLS scopes every read and write; nothing here opens its own context.
 */

export type EpisodeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The partial unique index that keeps one unresolved episode per device (the migration's name). */
export const ONE_UNRESOLVED_EPISODE_INDEX = 'device_network_isolations_one_unresolved_uniq';

const MAX_LIST_LIMIT = 100;

/**
 * Lock one episode row (`SELECT … FOR UPDATE`) for the rest of the transaction and run `fn` with it.
 * Returns null, without calling `fn`, when the row does not exist or is not visible under RLS; callers
 * must treat that as "no such episode", never as success.
 */
export async function withEpisodeLock<T>(
  tx: EpisodeTx,
  episodeId: string,
  fn: (row: DeviceNetworkIsolation) => Promise<T>,
): Promise<T | null> {
  const [row] = await tx
    .select()
    .from(deviceNetworkIsolations)
    .where(eq(deviceNetworkIsolations.id, episodeId))
    .limit(1)
    .for('update');
  if (!row) return null;
  return fn(row);
}

export type CreateEpisodeResult =
  | { ok: true; episode: DeviceNetworkIsolation }
  | { ok: false; error: 'isolation_already_active' };

/**
 * Insert a new episode. The device already having an unresolved episode (active, or awaiting
 * acknowledgement) is reported as `isolation_already_active` instead of throwing. The insert runs in a
 * savepoint, so that refusal leaves the caller's transaction usable. Any other error is rethrown.
 */
export async function createEpisode(tx: EpisodeTx, values: NewDeviceNetworkIsolation): Promise<CreateEpisodeResult> {
  try {
    const [episode] = await tx.transaction(async (sp) => sp.insert(deviceNetworkIsolations).values(values).returning());
    if (!episode) throw new Error('createEpisode: insert returned no row');
    return { ok: true, episode };
  } catch (err) {
    if (isPgUniqueViolation(err, ONE_UNRESOLVED_EPISODE_INDEX)) return { ok: false, error: 'isolation_already_active' };
    throw err;
  }
}

/** The device's one unresolved episode (active, released_locally or self_released), if any. */
export async function findUnresolvedEpisode(tx: EpisodeTx, deviceId: string): Promise<DeviceNetworkIsolation | null> {
  const [row] = await tx
    .select()
    .from(deviceNetworkIsolations)
    .where(and(
      eq(deviceNetworkIsolations.deviceId, deviceId),
      notInArray(deviceNetworkIsolations.state, [...RESOLVED_TERMINAL_STATES]),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * The newest release tombstone the agent has not yet confirmed (`desired_state = 'released'`,
 * `release_confirmed_at IS NULL`). The heartbeat keeps sending it until the agent reports absence.
 */
export async function findUnconfirmedTombstone(tx: EpisodeTx, deviceId: string): Promise<DeviceNetworkIsolation | null> {
  const [row] = await tx
    .select()
    .from(deviceNetworkIsolations)
    .where(and(
      eq(deviceNetworkIsolations.deviceId, deviceId),
      eq(deviceNetworkIsolations.desiredState, 'released'),
      isNull(deviceNetworkIsolations.releaseConfirmedAt),
    ))
    .orderBy(desc(deviceNetworkIsolations.createdAt), desc(deviceNetworkIsolations.id))
    .limit(1);
  return row ?? null;
}

/** A device's episodes, newest first. `limit` is clamped to 1..100 (default 20). */
export async function listEpisodes(
  tx: EpisodeTx,
  deviceId: string,
  opts: { limit?: number } = {},
): Promise<DeviceNetworkIsolation[]> {
  const requested = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : 20;
  const limit = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT);
  return tx
    .select()
    .from(deviceNetworkIsolations)
    .where(eq(deviceNetworkIsolations.deviceId, deviceId))
    .orderBy(desc(deviceNetworkIsolations.createdAt), desc(deviceNetworkIsolations.id))
    .limit(limit);
}

/** The state-machine view of a row. */
export function toEpisodeSnapshot(row: DeviceNetworkIsolation): EpisodeSnapshot {
  return {
    state: row.state,
    desiredState: row.desiredState,
    generation: row.generation,
    lastJournalSeq: row.lastJournalSeq,
    failureCode: row.failureCode ?? null,
    releaseKind: row.releaseKind ?? null,
    expiresAt: row.expiresAt,
    dispatchedAt: row.dispatchedAt ?? null,
    appliedAt: row.appliedAt ?? null,
    verifiedAt: row.verifiedAt ?? null,
    releaseRequestedAt: row.releaseRequestedAt ?? null,
    releasedAt: row.releasedAt ?? null,
    releaseConfirmedAt: row.releaseConfirmedAt ?? null,
    acknowledgedAt: row.acknowledgedAt ?? null,
    acknowledgedBy: row.acknowledgedBy ?? null,
  };
}

/**
 * Write a transition back to its (locked) row. Call only inside `withEpisodeLock` on the same `tx`, with
 * `next` from `applyEpisodeEvent` on that row. Returns false when the row vanished (a concurrent
 * device delete), which the caller must surface rather than treat as written.
 */
export async function writeEpisodeSnapshot(
  tx: EpisodeTx,
  episodeId: string,
  next: EpisodeSnapshot,
  at: Date = new Date(),
): Promise<boolean> {
  const updated = await tx
    .update(deviceNetworkIsolations)
    .set({ ...next, updatedAt: at })
    .where(eq(deviceNetworkIsolations.id, episodeId))
    .returning({ id: deviceNetworkIsolations.id });
  return updated.length === 1;
}
