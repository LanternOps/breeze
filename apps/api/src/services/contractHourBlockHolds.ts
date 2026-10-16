/**
 * Block hours (#8181, spec #4547) — which not_billed time is reserved for a
 * block's period close (Open Decision 9 A). Ad-hoc invoice assembly excludes
 * entries inside these windows, so a block-covered hour is billed by the close
 * and never ALSO by a hand-built invoice issued before the period closes.
 *
 * Reads only Shape-1 contract tables (contract_lines, contracts,
 * contract_billing_periods, contract_hour_periods), so it works in a system
 * context or in the assembling request's partner-scoped context. Kept apart
 * from contractHourBlockClose.ts (which imports invoiceService) so that
 * invoiceAssembly can use it without an import cycle.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { contractBillingPeriods, contractHourPeriods, contractLines, contracts } from '../db/schema';
import { computePeriod, periodIndexFor } from './contractMath';

export interface HourBlockHoldWindow {
  /** Inclusive instant (UTC midnight of a period start). */
  start: Date;
  /** Exclusive instant, or null = open-ended (the live block's current and future periods). */
  end: Date | null;
  contractLineId: string;
}

/** Period boundary instant: UTC midnight of the ISO date, half-open [start, end). */
export const hourBlockDayStart = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/**
 * The contract's claimed periods with each claim's true INSTANT.
 * contract_billing_periods.generated_at is `timestamp` WITHOUT time zone filled
 * by now(), i.e. session-local wall time; hour_block_retired_at is timestamptz.
 * Reading generated_at through Drizzle's no-tz mapping appends +0000, which is
 * only right when the server runs in UTC. Resolve it to an instant in SQL so the
 * "claimed while live" rule (generated_at <= retired_at) holds in any TimeZone —
 * including the equal case, a final period claimed and retired in one transaction.
 */
export async function loadPeriodClaims(contractId: string): Promise<Array<{ periodStart: string; periodEnd: string; generatedAt: Date }>> {
  const rows = await db.select({
    periodStart: contractBillingPeriods.periodStart,
    periodEnd: contractBillingPeriods.periodEnd,
    generatedAtUtc: sql<string>`to_char((${contractBillingPeriods.generatedAt} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contractId));
  return rows.map((r) => ({ periodStart: r.periodStart, periodEnd: r.periodEnd, generatedAt: new Date(r.generatedAtUtc) }));
}

/** True when a claim made at `generatedAt` entitles the line (claimed while live). */
export function claimedWhileLive(generatedAt: Date, retiredAt: Date | null): boolean {
  return retiredAt === null || generatedAt.getTime() <= retiredAt.getTime();
}

/**
 * Per block line L of the org:
 *  - W1: every claimed period P with P.start >= L.first_period_start, claimed
 *    while L was live, and no ledger row (L, P.start): [P.start, P.end).
 *  - W2: only when L is live and its contract is active:
 *    [max(first, min(currentPeriodStart, duePeriodStart)), ∞), where due is the
 *    period the next billing run will claim. The min closes the arrears gap
 *    between a period's end and the run that claims it.
 * Entries in unclaimed past periods (pause gaps) and in closed periods (late
 * entries) are NOT held — they bill ad hoc, the documented behaviour.
 */
export async function hourBlockHoldWindows(orgId: string, asOf: Date = new Date()): Promise<HourBlockHoldWindow[]> {
  const blocks = await db.select({ line: contractLines, contract: contracts })
    .from(contractLines).innerJoin(contracts, eq(contracts.id, contractLines.contractId))
    .where(and(eq(contractLines.orgId, orgId), eq(contractLines.lineType, 'hour_block')));
  const today = asOf.toISOString().slice(0, 10);
  const out: HourBlockHoldWindow[] = [];
  for (const { line, contract } of blocks) {
    const first = line.hourBlockFirstPeriodStart;
    if (first == null) continue; // contract_lines_hour_block_chk makes this unreachable
    const retiredAt = line.hourBlockRetiredAt ?? null;
    const claims = await loadPeriodClaims(contract.id);
    const closed = new Set((await db.select({ s: contractHourPeriods.periodStart }).from(contractHourPeriods)
      .where(eq(contractHourPeriods.contractLineId, line.id))).map((r) => r.s));
    for (const p of claims) {
      if (p.periodStart < first || closed.has(p.periodStart) || !claimedWhileLive(p.generatedAt, retiredAt)) continue;
      out.push({ start: hourBlockDayStart(p.periodStart), end: hourBlockDayStart(p.periodEnd), contractLineId: line.id }); // W1
    }
    if (retiredAt === null && (contract.status as string) === 'active') {
      // Period starts come from computePeriod (never addMonthsClamped(-n)) so a
      // 03-31 contract's periods line up with the claims. periodIndexFor clamps
      // at 0 for an asOf before the contract start.
      const cur = computePeriod(contract.startDate, contract.intervalMonths,
        periodIndexFor(contract.startDate, contract.intervalMonths, today)).periodStart;
      let due = cur;
      if (contract.nextBillingAt) {
        const idxAt = periodIndexFor(contract.startDate, contract.intervalMonths, contract.nextBillingAt);
        // generateDueInvoice's own rule: advance bills the period starting at the
        // pointer, arrears the one that just ended.
        due = computePeriod(contract.startDate, contract.intervalMonths,
          Math.max(0, contract.billingTiming === 'advance' ? idxAt : idxAt - 1)).periodStart;
      }
      const earliest = cur < due ? cur : due;
      out.push({ start: hourBlockDayStart(earliest < first ? first : earliest), end: null, contractLineId: line.id }); // W2
    }
  }
  return out;
}

/** True when an entry ending at `endedAt` falls inside any hold window. */
export function isHeldForHourBlock(windows: readonly HourBlockHoldWindow[], endedAt: Date): boolean {
  const t = endedAt.getTime();
  return windows.some((w) => t >= w.start.getTime() && (w.end === null || t < w.end.getTime()));
}
