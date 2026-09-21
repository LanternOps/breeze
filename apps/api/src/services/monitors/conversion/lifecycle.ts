import { and, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { monitorConversions } from '../../../db/schema';
import type { DbExecutor } from '../monitorCompiler';
import type { ConversionSourceTable } from './types';
export function isRevertAvailable(_sourceTable: ConversionSourceTable): boolean { return true; }
/** Response entries cannot revert while their target conversion is still live. */
export async function findLiveTargetDependencies(
  rows: Array<{ id: string; sourceState: Record<string, unknown> }>, executor: DbExecutor = db,
): Promise<Set<string>> {
  const targetIds = [...new Set(rows.map((r) => r.sourceState.targetConversionId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (!targetIds.length) return new Set();
  // Resolve outside the page/policy filter: a target can be on another ledger page.
  // Text comparison avoids treating malformed historical JSON as a UUID cast error.
  const live = await executor.select({ id: monitorConversions.id }).from(monitorConversions)
    .where(and(inArray(sql<string>`${monitorConversions.id}::text`, targetIds), isNull(monitorConversions.revertedAt)));
  const liveIds = new Set(live.map((r) => r.id));
  return new Set(rows.filter((r) => typeof r.sourceState.targetConversionId === 'string'
    && liveIds.has(r.sourceState.targetConversionId)).map((r) => r.id));
}
