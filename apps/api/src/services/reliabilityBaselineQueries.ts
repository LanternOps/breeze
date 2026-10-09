import { and, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceReliability, deviceReliabilityBaselines } from '../db/schema';
import type { ActiveReliabilityBaseline } from './reliabilityBaselinePolicy';

// #5876. The ONE ordering that defines "the active marker". Every reader and the
// compare-and-set guard must use it, or a tie on baseline_at could make the guard
// disagree with the scorer.
const ACTIVE_ORDER = [
  desc(deviceReliabilityBaselines.baselineAt),
  desc(deviceReliabilityBaselines.createdAt),
  desc(deviceReliabilityBaselines.id),
] as const;

export async function getActiveReliabilityBaseline(
  deviceId: string,
  // `before` is strict: a marker at exactly that instant is never its own predecessor.
  opts: { before?: Date } = {},
): Promise<ActiveReliabilityBaseline | null> {
  const conditions = [eq(deviceReliabilityBaselines.deviceId, deviceId), isNull(deviceReliabilityBaselines.clearedAt)];
  if (opts.before) conditions.push(lt(deviceReliabilityBaselines.baselineAt, opts.before));
  const [row] = await db
    .select({
      id: deviceReliabilityBaselines.id,
      baselineAt: deviceReliabilityBaselines.baselineAt,
      reason: deviceReliabilityBaselines.reason,
      source: deviceReliabilityBaselines.source,
    })
    .from(deviceReliabilityBaselines)
    .where(and(...conditions))
    .orderBy(...ACTIVE_ORDER)
    .limit(1);
  return row ?? null;
}

export function activeBaselineIdSql(deviceId: string): SQL {
  return sql`(SELECT ${deviceReliabilityBaselines.id} FROM ${deviceReliabilityBaselines}
    WHERE ${deviceReliabilityBaselines.deviceId} = ${deviceId} AND ${deviceReliabilityBaselines.clearedAt} IS NULL
    ORDER BY ${deviceReliabilityBaselines.baselineAt} DESC, ${deviceReliabilityBaselines.createdAt} DESC, ${deviceReliabilityBaselines.id} DESC
    LIMIT 1)`;
}

// Guarded cast: a non-boolean `provisional` must read as false, never throw and
// take down the device list or fleet findings with it.
export const reliabilityProvisionalSql: SQL<boolean> =
  sql<boolean>`coalesce(CASE WHEN jsonb_typeof(${deviceReliability.details}->'baseline'->'provisional') = 'boolean'
    THEN (${deviceReliability.details}->'baseline'->>'provisional')::boolean END, false)`;
