import { and, desc, eq, getTableColumns, isNull, notInArray } from 'drizzle-orm';
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
 *
 * Full rows (`DeviceNetworkIsolation`) carry `breakGlassSecretEnc`; they come only from the locked read
 * and the two heartbeat-side finders. Listing returns `EpisodeSummary`, which never does.
 */

export type EpisodeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The partial unique index that keeps one unresolved episode per device (the migration's name). */
export const ONE_UNRESOLVED_EPISODE_INDEX = 'device_network_isolations_one_unresolved_uniq';

const MAX_LIST_LIMIT = 100;

export type EpisodeLockResult<T> = { found: false } | { found: true; value: T };

/**
 * Lock one episode row (`SELECT … FOR UPDATE`) for the rest of the transaction and run `fn` with it.
 * `{ found: false }`, without calling `fn`, when the row does not exist or is not visible under RLS.
 */
export async function withEpisodeLock<T>(
  tx: EpisodeTx,
  episodeId: string,
  fn: (row: DeviceNetworkIsolation) => Promise<T>,
): Promise<EpisodeLockResult<T>> {
  const [row] = await tx
    .select()
    .from(deviceNetworkIsolations)
    .where(eq(deviceNetworkIsolations.id, episodeId))
    .limit(1)
    .for('update');
  if (!row) return { found: false };
  return { found: true, value: await fn(row) };
}

/**
 * What a new episode may be created with. The lifecycle (state, desired state, generation, ordering,
 * outcome and acknowledgement fields) always starts at the table defaults — isolate, generation 1,
 * `requested` — and only ever moves through `applyEpisodeEvent`.
 */
export type CreateEpisodeInput = Omit<
  NewDeviceNetworkIsolation,
  | 'id'
  | 'state'
  | 'desiredState'
  | 'generation'
  | 'lastJournalSeq'
  | 'failureCode'
  | 'releaseKind'
  | 'mechanism'
  | 'lastAgentReport'
  | 'breakGlassAckSeq'
  | 'expiryWarnedAt'
  | 'dispatchedAt'
  | 'appliedAt'
  | 'verifiedAt'
  | 'releaseRequestedAt'
  | 'releasedAt'
  | 'releaseConfirmedAt'
  | 'acknowledgedAt'
  | 'acknowledgedBy'
  | 'releaseCommandId'
  | 'createdAt'
  | 'updatedAt'
>;

export type CreateEpisodeResult =
  | { ok: true; episode: DeviceNetworkIsolation }
  | { ok: false; error: 'isolation_already_active' };

/**
 * Insert a new episode. The device already having an unresolved episode (active, or awaiting
 * acknowledgement) is reported as `isolation_already_active` instead of throwing. The insert runs in a
 * savepoint, so that refusal leaves the caller's transaction usable. Any other error is rethrown.
 */
export async function createEpisode(tx: EpisodeTx, values: CreateEpisodeInput): Promise<CreateEpisodeResult> {
  // The type omits the lifecycle fields, but a wider object still type-checks; pin them at runtime too.
  const row: NewDeviceNetworkIsolation = {
    ...values,
    state: 'requested',
    desiredState: 'isolated',
    generation: 1,
    lastJournalSeq: 0,
    failureCode: null,
    releaseKind: null,
    mechanism: null,
    lastAgentReport: null,
    breakGlassAckSeq: null,
    expiryWarnedAt: null,
    dispatchedAt: null,
    appliedAt: null,
    verifiedAt: null,
    releaseRequestedAt: null,
    releasedAt: null,
    releaseConfirmedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    releaseCommandId: null,
  };
  try {
    const [episode] = await tx.transaction(async (sp) => sp.insert(deviceNetworkIsolations).values(row).returning());
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
 * `release_confirmed_at IS NULL`). The heartbeat keeps sending it until the agent reports absence; an
 * older unconfirmed one (rare) surfaces on the next beat once this one is confirmed.
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

/** An episode without its break-glass ciphertext: safe to hand to a route or the AI. */
export type EpisodeSummary = Omit<DeviceNetworkIsolation, 'breakGlassSecretEnc'>;

const { breakGlassSecretEnc: _secret, ...summaryColumns } = getTableColumns(deviceNetworkIsolations);
void _secret;

/** A device's episodes, newest first, without the secret. `limit` is clamped to 1..100 (default 20). */
export async function listEpisodes(
  tx: EpisodeTx,
  deviceId: string,
  opts: { limit?: number } = {},
): Promise<EpisodeSummary[]> {
  const requested = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : 20;
  const limit = Math.min(Math.max(requested, 1), MAX_LIST_LIMIT);
  return tx
    .select(summaryColumns)
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
 * Write a transition back: `prev` is the snapshot `applyEpisodeEvent` was given, `next` what it
 * returned. Only the snapshot columns are written, and only if the row still holds `prev`'s state,
 * generation and journal high-water mark (compare-and-swap). Under `withEpisodeLock` that always
 * holds; outside it, a concurrent writer makes this return false instead of overwriting newer state.
 * False also means the row vanished (a concurrent device delete). Callers must handle false.
 */
export async function writeEpisodeSnapshot(
  tx: EpisodeTx,
  episodeId: string,
  prev: EpisodeSnapshot,
  next: EpisodeSnapshot,
  at: Date = new Date(),
): Promise<boolean> {
  const updated = await tx
    .update(deviceNetworkIsolations)
    .set({
      state: next.state,
      desiredState: next.desiredState,
      generation: next.generation,
      lastJournalSeq: next.lastJournalSeq,
      failureCode: next.failureCode,
      releaseKind: next.releaseKind,
      expiresAt: next.expiresAt,
      dispatchedAt: next.dispatchedAt,
      appliedAt: next.appliedAt,
      verifiedAt: next.verifiedAt,
      releaseRequestedAt: next.releaseRequestedAt,
      releasedAt: next.releasedAt,
      releaseConfirmedAt: next.releaseConfirmedAt,
      acknowledgedAt: next.acknowledgedAt,
      acknowledgedBy: next.acknowledgedBy,
      updatedAt: at,
    })
    .where(and(
      eq(deviceNetworkIsolations.id, episodeId),
      eq(deviceNetworkIsolations.state, prev.state),
      eq(deviceNetworkIsolations.generation, prev.generation),
      eq(deviceNetworkIsolations.lastJournalSeq, prev.lastJournalSeq),
    ))
    .returning({ id: deviceNetworkIsolations.id });
  return updated.length === 1;
}
