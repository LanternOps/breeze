import { and, desc, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
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
  opts: { atOrBefore?: Date } = {},
): Promise<ActiveReliabilityBaseline | null> {
  const conditions = [eq(deviceReliabilityBaselines.deviceId, deviceId), isNull(deviceReliabilityBaselines.clearedAt)];
  if (opts.atOrBefore) conditions.push(lte(deviceReliabilityBaselines.baselineAt, opts.atOrBefore));
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

export const reliabilityProvisionalSql: SQL<boolean> =
  sql<boolean>`coalesce((${deviceReliability.details}->'baseline'->>'provisional')::boolean, false)`;
