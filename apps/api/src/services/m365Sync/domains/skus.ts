import { db } from '../../../db';
import { m365LicenseSkus } from '../../../db/schema';
import { canonicalHash } from '../hash';
import {
  M365_SYNC_PRIMARY_SOURCE_KEY,
  type DomainPersistResult, type M365SyncActionResult, type PersistContext,
} from '../types';
import {
  markEntitiesStale, planEntityWrites, sqlExcluded, sqlFalse, sqlNull, writeEntityChunks,
} from './persist';

interface SkuItem {
  skuId?: string;
  skuPartNumber?: string | null;
  consumedUnits?: number | null;
  prepaidUnits?: { enabled?: number | null; suspended?: number | null; warning?: number | null } | null;
  capabilityStatus?: string | null;
  appliesTo?: string | null;
}

/**
 * Seat counts feed a licensing view and the rollup, so a non-numeric value must
 * become 0, never NaN: one NaN would make `seats_purchased` NaN for the whole
 * org and the rollup would render "—" for a tenant that has licences.
 */
function unitCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function projection(item: SkuItem): Record<string, unknown> {
  return {
    skuPartNumber: item.skuPartNumber ?? null,
    consumedUnits: unitCount(item.consumedUnits),
    prepaidEnabled: unitCount(item.prepaidUnits?.enabled),
    prepaidSuspended: unitCount(item.prepaidUnits?.suspended),
    prepaidWarning: unitCount(item.prepaidUnits?.warning),
    capabilityStatus: item.capabilityStatus ?? null,
    appliesTo: item.appliesTo ?? null,
  };
}

export async function persistSkus(
  ctx: PersistContext,
  result: M365SyncActionResult,
): Promise<DomainPersistResult> {
  const items = result.items as SkuItem[];
  const primaryOk = result.sources[M365_SYNC_PRIMARY_SOURCE_KEY.skus] === 'ok';
  const complete = primaryOk && !result.truncated;

  const plan = planEntityWrites(ctx, items, complete, (item) => {
    if (!item.skuId) return null;
    const p = projection(item);
    return {
      // graph_id carries the Graph `skuId` (spec §3.2). There is NO separate
      // sku_id column: one column shape across all four domains is what lets
      // planEntityWrites, markEntitiesStale and PersistContext.existing be
      // written once.
      graphId: item.skuId,
      coreHash: canonicalHash(p),
      row: {
        orgId: ctx.orgId,
        graphId: item.skuId,
        skuPartNumber: p.skuPartNumber as string | null,
        consumedUnits: p.consumedUnits as number,
        prepaidEnabled: p.prepaidEnabled as number,
        prepaidSuspended: p.prepaidSuspended as number,
        prepaidWarning: p.prepaidWarning as number,
        capabilityStatus: p.capabilityStatus as string | null,
        appliesTo: p.appliesTo as string | null,
        coreHash: canonicalHash(p),
        firstSeenAt: ctx.now,
        lastChangedAt: ctx.now,
        isStale: false,
        staleSince: null,
      },
    };
  });

  await writeEntityChunks(plan.rows, async (chunk) => {
    await db.insert(m365LicenseSkus).values(chunk).onConflictDoUpdate({
      target: [m365LicenseSkus.orgId, m365LicenseSkus.graphId],
      set: {
        skuPartNumber: sqlExcluded('sku_part_number'),
        consumedUnits: sqlExcluded('consumed_units'),
        prepaidEnabled: sqlExcluded('prepaid_enabled'),
        prepaidSuspended: sqlExcluded('prepaid_suspended'),
        prepaidWarning: sqlExcluded('prepaid_warning'),
        capabilityStatus: sqlExcluded('capability_status'),
        appliesTo: sqlExcluded('applies_to'),
        coreHash: sqlExcluded('core_hash'),
        lastChangedAt: sqlExcluded('last_changed_at'),
        isStale: sqlFalse(),
        staleSince: sqlNull(),
      },
    });
  }, ctx);

  const stale = plan.staleIds.length
    ? await markEntitiesStale(m365LicenseSkus as never, ctx.orgId, plan.staleIds, ctx.now, ctx)
    : 0;

  let seatsPurchased = 0;
  let seatsConsumed = 0;
  for (const item of items) {
    seatsPurchased += unitCount(item.prepaidUnits?.enabled);
    seatsConsumed += unitCount(item.consumedUnits);
  }

  return {
    inserted: plan.inserted, updated: plan.updated, unchanged: plan.unchanged, stale, complete,
    // Rollup column names only (spec §5.9) — there is no `skus_total` column.
    counts: { seats_purchased: seatsPurchased, seats_consumed: seatsConsumed },
  };
}
