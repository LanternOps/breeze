import type { HourBlockEstimate, PortalHourBlockDto, PortalHourBlockResponse } from '@breeze/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contractLines, contracts } from '../../db/schema';
// The live OPEN-period computation behind computeContractEstimate(...).hourBlock.
// It reads time_entries, which is partner-axis RLS, so it accepts a system OR
// partner-scoped context and throws under an org scope.
import { computeOpenHourBlockPeriod } from '../contractHourBlockEstimate';

/**
 * Explicit whitelist, never a spread: HourBlockEstimate carries MSP-side
 * figures (unapproved / foreign-currency / late-entry hours, the line id, the
 * alert threshold, the projected overage value) a customer must not see.
 */
export function toPortalHourBlockDto(
  estimate: HourBlockEstimate,
  currencyCode: string,
): PortalHourBlockDto {
  return {
    periodStart: estimate.periodStart,
    periodEnd: estimate.periodEnd,
    includedHours: estimate.includedHours,
    carriedInHours: estimate.carriedInHours,
    usedHours: estimate.consumedHours,
    remainingHours: estimate.remainingHours,
    overageHours: estimate.overageHours,
    overageRate: estimate.overageUnitPrice,
    currencyCode,
    billingTiming: estimate.billingTiming,
  };
}

/**
 * The org's live block and its OPEN-period estimate, or null. Only the active
 * contract's live (non-retired) block counts: at most one exists per org
 * (contract_lines_one_live_hour_block_per_org_uq).
 *
 * MUST be called inside a system DB context; it opens none of its own, so a
 * caller that already holds one (the Support usage buckets) does not take a
 * second pooled connection. Scoping is by the explicit org predicate on BOTH
 * tables, not by RLS.
 */
export async function liveHourBlockForOrg(
  orgId: string,
  asOf: Date,
): Promise<{ estimate: HourBlockEstimate; currencyCode: string } | null> {
  const [row] = await db
    .select({ contract: contracts, line: contractLines })
    .from(contractLines)
    .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(
      and(
        eq(contractLines.orgId, orgId),
        eq(contracts.orgId, orgId),
        eq(contractLines.lineType, 'hour_block'),
        isNull(contractLines.hourBlockRetiredAt),
        eq(contracts.status, 'active'),
      ),
    )
    .limit(1);

  if (!row) return null;
  const estimate = await computeOpenHourBlockPeriod(row.contract, row.line, asOf);
  return { estimate, currencyCode: row.contract.currencyCode };
}

/**
 * The portal's view of the org's block balance.
 *
 * Runs in a SYSTEM context entered from OUTSIDE the request context: the portal
 * session's own org context cannot read time_entries (partner-axis) and the
 * open-period helper throws under an org scope. The caller must pass the
 * SESSION org (`portalAuth.user.orgId`), never request input.
 *
 * A block whose open period starts after today (added mid-period, so its first
 * period is the next one) is reported as `startsOn`, not as a card.
 */
export async function portalHourBlockForOrg(args: {
  orgId: string;
  asOf?: Date;
}): Promise<PortalHourBlockResponse> {
  const asOf = args.asOf ?? new Date();

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async (): Promise<PortalHourBlockResponse> => {
      const live = await liveHourBlockForOrg(args.orgId, asOf);
      if (!live) return { hourBlock: null, startsOn: null };

      const today = asOf.toISOString().slice(0, 10);
      if (live.estimate.periodStart > today) {
        return { hourBlock: null, startsOn: live.estimate.periodStart };
      }
      return { hourBlock: toPortalHourBlockDto(live.estimate, live.currencyCode), startsOn: null };
    }),
  );
}
