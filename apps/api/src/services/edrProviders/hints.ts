import type { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import type { EdrWebhookHint } from './types';

/**
 * Durable push hints (EDR W03 PR-B, plan B3). A vendor push only says "this
 * connection has news". Two stores:
 *
 *  - `edr_connections.pending_hint_at` — the DURABLE marker. Set by the
 *    webhook; CAS-cleared by the detections run only after its Phase 3 commits,
 *    and only up to the marker value that run snapshotted. A hint that arrives
 *    mid-run therefore survives (its marker is newer) and triggers one rerun;
 *    a crash or failed run clears nothing. `sync-all` treats an unacked marker
 *    as "due", so durability never depends on Redis or on the rerun enqueue.
 *  - Redis set `edr:hints:<connectionId>` — tenant/detection granularity for a
 *    future adapter with targeted fetches (`t:<tenant>`, `d:<tenant>:<det>`),
 *    capped at 500 members, 1 h TTL. Best effort: every Redis failure is
 *    logged and ignored.
 *
 * The marker is read and compared as Postgres TEXT, never through a JS Date:
 * a Date truncates microseconds, so `pending_hint_at <= <ms value>` would never
 * match the value it came from and the CAS would never clear (endless reruns).
 *
 * Nothing here writes detections, calls a vendor, or touches edr_actions: a
 * hint only schedules a read sync.
 */

export const EDR_HINT_SET_CAP = 500;
export const EDR_HINT_TTL_SECONDS = 3600;
/** "Last push event" display only; loss is harmless. */
export const EDR_LAST_HINT_TTL_SECONDS = 30 * 86_400;

const setKey = (connectionId: string) => `edr:hints:${connectionId}`;
const lastKey = (connectionId: string) => `edr:hints:last:${connectionId}`;

export interface EdrHintSnapshot {
  /** Exactly the Redis members seen; the ack removes these and nothing else. */
  members: string[];
  hints: EdrWebhookHint[];
  /** `pending_hint_at` as Postgres text (microsecond-exact), or null when unset. */
  markerAt: string | null;
}

export function hintMember(h: EdrWebhookHint): string | null {
  if (!h.vendorTenantId) return null;
  return h.vendorDetectionId ? `d:${h.vendorTenantId}:${h.vendorDetectionId}` : `t:${h.vendorTenantId}`;
}

function memberHint(m: string): EdrWebhookHint | null {
  const parts = m.split(':');
  if (parts[0] === 't' && parts.length === 2 && parts[1]) return { vendorTenantId: parts[1] };
  if (parts[0] === 'd' && parts.length === 3 && parts[1] && parts[2]) {
    return { vendorTenantId: parts[1], vendorDetectionId: parts[2] };
  }
  return null;
}

function logRedis(op: string, connectionId: string, error: unknown): void {
  console.warn(`[edrHints] ${op} failed for ${connectionId} (DB marker still authoritative):`,
    error instanceof Error ? error.message : String(error));
}

/**
 * Record one authenticated push. Sets the durable marker FIRST (throws on a DB
 * failure so the webhook answers 5xx and the vendor can retry), then the Redis
 * set (best effort). Returns false when the connection is no longer active and
 * push-enabled (nothing recorded). Must run outside a request DB context.
 */
export async function recordEdrHint(connectionId: string, hints: EdrWebhookHint[], redis: Redis | null): Promise<boolean> {
  const rows = (await withSystemDbAccessContext(() => db.execute(sql`
    UPDATE edr_connections
       SET pending_hint_at = GREATEST(COALESCE(pending_hint_at, now()), now())
     WHERE id = ${connectionId}::uuid AND is_active AND push_enabled
     RETURNING id
  `), 'edrHints.record')) as unknown as Array<{ id: string }>;
  if (rows.length === 0) return false;

  if (redis) {
    const members = [...new Set(hints.map(hintMember).filter((m): m is string => m !== null))];
    try {
      if (members.length > 0) {
        const n = await redis.scard(setKey(connectionId));
        const room = Math.max(0, EDR_HINT_SET_CAP - n);
        if (room > 0) await redis.sadd(setKey(connectionId), ...members.slice(0, room));
        await redis.expire(setKey(connectionId), EDR_HINT_TTL_SECONDS);
      }
      await redis.set(lastKey(connectionId), new Date().toISOString(), 'EX', EDR_LAST_HINT_TTL_SECONDS);
    } catch (error) {
      logRedis('record', connectionId, error);
    }
  }
  return true;
}

/** Snapshot (clears nothing): the Redis members and the marker as exact text. */
export async function readEdrHints(connectionId: string, redis: Redis | null): Promise<EdrHintSnapshot> {
  let members: string[] = [];
  if (redis) {
    try {
      members = await redis.smembers(setKey(connectionId));
    } catch (error) {
      logRedis('read', connectionId, error);
    }
  }
  const [row] = (await withSystemDbAccessContext(() => db.execute(sql`
    SELECT pending_hint_at::text AS marker FROM edr_connections WHERE id = ${connectionId}::uuid
  `), 'edrHints.read')) as unknown as Array<{ marker: string | null }>;
  return {
    members,
    hints: members.map(memberHint).filter((h): h is EdrWebhookHint => h !== null),
    markerAt: row?.marker ?? null,
  };
}

/**
 * Acknowledge a snapshot after the detections run COMMITTED: remove exactly the
 * snapshotted members, CAS-clear the marker only if it has not advanced past
 * the snapshot, and report whether a newer hint is still pending (the caller
 * then enqueues one rerun).
 */
export async function ackEdrHints(
  connectionId: string,
  snap: EdrHintSnapshot,
  redis: Redis | null,
): Promise<{ stillPending: boolean }> {
  if (redis && snap.members.length > 0) {
    try {
      await redis.srem(setKey(connectionId), ...snap.members);
    } catch (error) {
      logRedis('ack', connectionId, error);
    }
  }
  const [row] = (await withSystemDbAccessContext(async () => {
    if (snap.markerAt !== null) {
      await db.execute(sql`
        UPDATE edr_connections SET pending_hint_at = NULL
         WHERE id = ${connectionId}::uuid AND pending_hint_at <= ${snap.markerAt}::timestamptz
      `);
    }
    return db.execute(sql`
      SELECT (pending_hint_at IS NOT NULL) AS pending FROM edr_connections WHERE id = ${connectionId}::uuid
    `);
  }, 'edrHints.ack')) as unknown as Array<{ pending: boolean }>;
  return { stillPending: row?.pending === true };
}

/** "Last push event" per connection for the connections list (best effort; Redis only). */
export async function readLastEdrHintAt(connectionIds: string[], redis: Redis | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!redis || connectionIds.length === 0) return out;
  try {
    const values = await redis.mget(...connectionIds.map(lastKey));
    connectionIds.forEach((id, i) => {
      const v = values[i];
      if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) out.set(id, v);
    });
  } catch (error) {
    logRedis('last', connectionIds.join(','), error);
  }
  return out;
}
