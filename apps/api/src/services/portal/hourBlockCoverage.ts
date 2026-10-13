import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { contractHourPeriods, portalBranding } from '../../db/schema';
// The SAME windows ad-hoc invoice assembly uses to withhold block-eligible
// entries, so "held from ad-hoc billing" and "shown as covered by the block"
// cannot drift apart.
import { hourBlockHoldWindows } from '../contractHourBlockClose';
import { liveHourBlockForOrg } from './hourBlock';
import type { BlockPeriodCoverage, HourBlockHoldWindow } from './hourBlockWindows';

export interface HourBlockCoverage {
  windows: HourBlockHoldWindow[];
  periods: BlockPeriodCoverage[];
}

/**
 * The block-coverage context for an org's Support usage buckets, or null when
 * the org's `enable_hour_block` flag is off/absent (the buckets then stay
 * exactly as they were).
 *
 * MUST be called inside a system DB context (the ledger, the hold windows and
 * the open-period estimate read partner-axis time_entries neighbours). It opens
 * NO context of its own: the caller already holds one, and a second would take
 * a second pooled connection while the first is still checked out. Every read is
 * pinned to `orgId` by an explicit predicate.
 */
export async function hourBlockCoverageForOrg(
  orgId: string,
  asOf: Date = new Date(),
): Promise<HourBlockCoverage | null> {
  const [flag] = await db
    .select({ enabled: portalBranding.enableHourBlock })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);
  if (flag?.enabled !== true) return null;

  const windows = await hourBlockHoldWindows(orgId, asOf);

  const closed = await db
    .select({
      periodStart: contractHourPeriods.periodStart,
      periodEnd: contractHourPeriods.periodEnd,
      overageHours: contractHourPeriods.overageHours,
    })
    .from(contractHourPeriods)
    .where(eq(contractHourPeriods.orgId, orgId));
  const periods: BlockPeriodCoverage[] = closed.map((p) => ({
    start: new Date(`${p.periodStart}T00:00:00Z`),
    end: new Date(`${p.periodEnd}T00:00:00Z`),
    overageMinutes: Math.round(Number(p.overageHours) * 60),
  }));

  const live = await liveHourBlockForOrg(orgId, asOf);
  if (live) {
    periods.push({
      start: new Date(`${live.estimate.periodStart}T00:00:00Z`),
      end: new Date(`${live.estimate.periodEnd}T00:00:00Z`),
      overageMinutes: Math.round(live.estimate.overageHours * 60),
    });
  }
  return { windows, periods };
}
