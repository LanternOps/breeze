/**
 * Daily per-scope (device / org) row and byte ingest budgets, Redis-backed.
 *
 * The per-request row cap and the per-minute request-count rate limiters
 * (`agentOrgRateLimit.ts`, `rate-limit.ts`) bound the RATE an agent can call an
 * ingest endpoint, but neither bounds the total volume a credential can push
 * over a day — a misbehaving agent still admitted at the
 * per-request/per-minute ceilings can sustain millions of rows and tens of GB
 * per day, which lands on shared Postgres disk, WAL and backups for every
 * tenant on the instance (not just its own). This module adds a coarser,
 * longer-window budget underneath those limiters: how many rows and bytes a
 * device or org may land in a rolling UTC day.
 *
 * Fails OPEN (admits the request) when Redis is unavailable. The per-request
 * rate limiters already fail closed and would already be rejecting most
 * traffic in that situation; failing this budget closed too would turn a
 * Redis outage into a total ingest outage for diagnostic/security log data
 * every tenant depends on, which is a worse failure mode than a temporarily
 * unbounded (but still per-request-capped) budget.
 */

import type { Redis } from 'ioredis';

export type IngestQuotaScope = 'device' | 'org';

export interface IngestQuotaResult {
  allowed: boolean;
  rowsUsed: number;
  bytesUsed: number;
}

/** UTC day bucket, e.g. "2026-09-25" — rolls over at midnight UTC. */
function utcDayBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function quotaKey(prefix: string, scope: IngestQuotaScope, id: string, unit: 'rows' | 'bytes', day: string): string {
  return `ingest_quota:${prefix}:${unit}:${scope}:${id}:${day}`;
}

/** Slightly over 24h so a request right at day-rollover still has a live TTL to read. */
const QUOTA_KEY_TTL_SECONDS = 25 * 60 * 60;

/**
 * Consume `rows`/`bytes` against a scope's daily budget and report whether the
 * scope was ALREADY over budget before this call (i.e. whether this batch
 * should be dropped). The consumption still happens even when the result is
 * `allowed: false` — the point is to count every attempt including the one(s)
 * that overflow, not to protect a precise ceiling to the byte. A single
 * request can therefore push the counter slightly past `maxRows`/`maxBytes`;
 * that's fine, the NEXT request is what actually gets refused.
 */
export async function checkAndConsumeIngestQuota(params: {
  redis: Redis | null;
  prefix: string;
  scope: IngestQuotaScope;
  id: string;
  rows: number;
  bytes: number;
  maxRows: number;
  maxBytes: number;
  now?: Date;
}): Promise<IngestQuotaResult> {
  const { redis, prefix, scope, id, rows, bytes, maxRows, maxBytes } = params;
  const now = params.now ?? new Date();

  if (!redis) {
    // See module doc: fail open, not closed.
    return { allowed: true, rowsUsed: 0, bytesUsed: 0 };
  }

  const day = utcDayBucket(now);
  const rowsKey = quotaKey(prefix, scope, id, 'rows', day);
  const bytesKey = quotaKey(prefix, scope, id, 'bytes', day);

  try {
    const results = await redis
      .multi()
      .incrby(rowsKey, Math.max(0, Math.floor(rows)))
      .expire(rowsKey, QUOTA_KEY_TTL_SECONDS)
      .incrby(bytesKey, Math.max(0, Math.floor(bytes)))
      .expire(bytesKey, QUOTA_KEY_TTL_SECONDS)
      .exec();

    if (!results) {
      return { allowed: true, rowsUsed: 0, bytesUsed: 0 };
    }

    const rowsUsed = Number(results[0]?.[1] ?? 0);
    const bytesUsed = Number(results[2]?.[1] ?? 0);

    return {
      allowed: rowsUsed <= maxRows && bytesUsed <= maxBytes,
      rowsUsed,
      bytesUsed,
    };
  } catch (err) {
    console.error(`[ingestQuota] Redis check failed for ${prefix}:${scope}:${id} — failing open`, err);
    return { allowed: true, rowsUsed: 0, bytesUsed: 0 };
  }
}
