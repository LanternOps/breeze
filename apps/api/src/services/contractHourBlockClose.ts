/**
 * Block hours (#8181, spec #4547) — the period close. Runs INSIDE the caller's
 * system transaction (generateDueInvoice or the close-out sweep), which already
 * holds the contract row lock. time_entries is partner-axis RLS: an org-scoped
 * context would see zero rows here, which is why every caller is system.
 *
 * The close CLAIMS rows, it does not count them (spec §2 "Claiming the
 * entries"): SELECT … ORDER BY id FOR UPDATE, compute from exactly the locked
 * set, flip exactly that set. ORDER BY id is issueInvoice's order, so the two
 * paths serialize instead of deadlocking.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { assertInTransaction, db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { contractHourPeriods, contractLines, contracts, timeEntries } from '../db/schema';
import { addContractLine, createManualInvoice } from './invoiceService';
import { buildAutomationEligibleOrgPredicate } from './tenantStatus';
import { captureException } from './sentry';
import type { InvoiceActor } from './invoiceTypes';
import { ContractServiceError } from './contractTypes';
import { hourBlockDayStart, loadPeriodClaims } from './contractHourBlockHolds';
import {
  computePeriodMath, selectClosablePeriods, sumEntryHours, type ClosablePeriod, type RolloverPolicy,
} from './contractHourBlocks';

// Index C7 names this module as the import path for the hold windows.
export { hourBlockHoldWindows, type HourBlockHoldWindow } from './contractHourBlockHolds';

export interface HourBlockCloseSummary {
  contractLineId: string; description: string;
  periodStart: string; periodEnd: string;
  includedHours: number; carriedInHours: number; consumedHours: number;
  overageHours: number; carriedOutHours: number; foreignCurrencyHours: number;
  entryCount: number;
  overageInvoiceLineId: string | null;
  closeSource: 'billing_run' | 'close_out';
}

type ContractRow = typeof contracts.$inferSelect;
type LineRow = typeof contractLines.$inferSelect;
type OverageInvoice = { id: string; actor: InvoiceActor };

const dayStart = hourBlockDayStart;
const todayUTC = (d: Date): string => d.toISOString().slice(0, 10);

/** Closes every closable period of one block line, earliest first. Caller holds the contract row lock. */
export async function closeHourBlockPeriods(args: {
  contract: ContractRow; line: LineRow;
  overageInvoice: OverageInvoice | (() => Promise<OverageInvoice>);
  closeSource: 'billing_run' | 'close_out'; asOf: Date;
}): Promise<{ closes: HourBlockCloseSummary[]; truncated: boolean }> {
  assertInTransaction('closeHourBlockPeriods');
  const { contract, line } = args;
  if (line.lineType !== 'hour_block' || line.hourBlockFirstPeriodStart == null
    || line.includedQuantity == null || line.overageUnitPrice == null || line.rolloverPolicy == null) {
    // contract_lines_hour_block_chk makes these non-null on a block line; a row
    // that slips past it must fail loudly, never close against a guessed zero.
    throw new ContractServiceError(`Contract line ${line.id} is not a complete block of hours`, 500, 'INVALID_STATE');
  }

  const claims = await loadPeriodClaims(contract.id);
  const closed = await db.select({ s: contractHourPeriods.periodStart }).from(contractHourPeriods)
    .where(eq(contractHourPeriods.contractLineId, line.id));
  const { periods, truncated } = selectClosablePeriods({
    contractStartDate: contract.startDate, intervalMonths: contract.intervalMonths,
    firstPeriodStart: line.hourBlockFirstPeriodStart,
    retiredAt: line.hourBlockRetiredAt ?? null,
    claims,
    closedPeriodStarts: new Set(closed.map((r) => r.s)),
    todayISO: todayUTC(args.asOf),
  });
  if (truncated) {
    console.warn('[contractHourBlocks] close backlog hit the cap; the rest close on later runs',
      { contractId: contract.id, lineId: line.id, closing: periods.length });
  }

  let invoice: OverageInvoice | null = typeof args.overageInvoice === 'function' ? null : args.overageInvoice;
  const getInvoice = async (): Promise<OverageInvoice> => {
    if (!invoice) invoice = await (args.overageInvoice as () => Promise<OverageInvoice>)();
    return invoice;
  };
  const out: HourBlockCloseSummary[] = [];
  for (const p of periods) {
    out.push(await closeOne(contract, line, p, args.closeSource, getInvoice));
  }
  return { closes: out, truncated };
}

/** Rollover in: the carried-out hours of the latest earlier closed period (pause gaps skip, never grant). */
async function carriedInFor(lineId: string, periodStart: string): Promise<number> {
  const [prev] = await db.select({ out: contractHourPeriods.carriedOutHours }).from(contractHourPeriods)
    .where(and(eq(contractHourPeriods.contractLineId, lineId), lt(contractHourPeriods.periodStart, periodStart)))
    .orderBy(desc(contractHourPeriods.periodStart)).limit(1);
  return prev ? Number(prev.out) : 0;
}

async function closeOne(
  contract: ContractRow, line: LineRow, p: ClosablePeriod,
  closeSource: 'billing_run' | 'close_out', getInvoice: () => Promise<OverageInvoice>,
): Promise<HourBlockCloseSummary> {
  // 1. Claim: lock exactly the eligible rows, in issueInvoice's order.
  const locked = await db.select({
    id: timeEntries.id,
    minutes: sql<number>`COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes}, 0)`.mapWith(Number),
    currencyCode: timeEntries.currencyCode,
  }).from(timeEntries).where(and(
    eq(timeEntries.orgId, contract.orgId),
    eq(timeEntries.isBillable, true),
    eq(timeEntries.billingStatus, 'not_billed'),
    isNotNull(timeEntries.endedAt),
    gte(timeEntries.endedAt, dayStart(p.periodStart)),
    lt(timeEntries.endedAt, dayStart(p.periodEnd)),
  )).orderBy(asc(timeEntries.id)).for('update');

  // 2. Compute from exactly the locked set.
  const consumed = sumEntryHours(locked.map((r) => r.minutes));
  const foreign = sumEntryHours(locked.filter((r) => r.currencyCode !== contract.currencyCode).map((r) => r.minutes));
  const carriedIn = await carriedInFor(line.id, p.periodStart);
  const math = computePeriodMath({
    includedQuantity: line.includedQuantity!, overageUnitPrice: line.overageUnitPrice!,
    rolloverPolicy: line.rolloverPolicy as RolloverPolicy, rolloverCapHours: line.rolloverCapHours ?? null,
  }, carriedIn, consumed);

  // 3. Mark exactly that set; any drift aborts the whole caller transaction.
  const ids = locked.map((r) => r.id);
  if (ids.length > 0) {
    const flipped = await db.update(timeEntries)
      .set({ billingStatus: 'contract', contractLineId: line.id, updatedAt: new Date() })
      .where(and(inArray(timeEntries.id, ids), eq(timeEntries.billingStatus, 'not_billed')))
      .returning({ id: timeEntries.id });
    if (flipped.length !== ids.length) {
      throw new ContractServiceError(
        `Block close for line ${line.id} locked ${ids.length} entries but marked ${flipped.length}`,
        500, 'HOUR_BLOCK_CLOSE_MISMATCH');
    }
  }

  // 4. Overage line (bill is the only mode — contract_lines_hour_block_chk).
  let overageInvoiceLineId: string | null = null;
  let overageInvoiceId: string | null = null;
  if (math.overageHours > 0) {
    const inv = await getInvoice();
    // Lock-order exception: addContractLine locks invoice -> contract, and we
    // already hold the contract. The invoice is either this run's own
    // uncommitted draft (billing path) or one the sweep just created in this
    // transaction — nothing else can hold it, so the order cannot cycle.
    const { line: il } = await addContractLine(inv.id, {
      description: `${line.description} — hours over block, ${p.periodStart} – ${p.periodEnd}`,
      quantity: math.overageHours.toFixed(2),
      unitPrice: line.overageUnitPrice!,
      taxable: line.taxable,
      catalogItemId: null,
      sourceId: line.id,
      contractId: contract.id,
    }, inv.actor);
    overageInvoiceLineId = il.id;
    overageInvoiceId = inv.id;
  }

  // 5. Ledger row. The unique key makes a lost race a no-op; a no-op AFTER we
  //    marked rows means another closer won between our select and insert —
  //    impossible under the contract row lock, so it is corruption, not a skip.
  const inserted = await db.insert(contractHourPeriods).values({
    contractLineId: line.id, contractId: contract.id, orgId: contract.orgId,
    periodStart: p.periodStart, periodEnd: p.periodEnd,
    includedHours: math.includedHours.toFixed(2), carriedInHours: math.carriedInHours.toFixed(2),
    consumedHours: math.consumedHours.toFixed(2), overageHours: math.overageHours.toFixed(2),
    carriedOutHours: math.carriedOutHours.toFixed(2), foreignCurrencyHours: foreign.toFixed(2),
    entryCount: ids.length, overageUnitPrice: line.overageUnitPrice!, currencyCode: contract.currencyCode,
    overageInvoiceId, closeSource,
  }).onConflictDoNothing({ target: [contractHourPeriods.contractLineId, contractHourPeriods.periodStart] })
    .returning({ id: contractHourPeriods.id });
  if (inserted.length === 0) {
    throw new ContractServiceError(
      `Block period ${p.periodStart} for line ${line.id} closed concurrently`, 500, 'HOUR_BLOCK_CLOSE_MISMATCH');
  }

  return {
    contractLineId: line.id, description: line.description,
    periodStart: p.periodStart, periodEnd: p.periodEnd,
    includedHours: math.includedHours, carriedInHours: math.carriedInHours, consumedHours: math.consumedHours,
    overageHours: math.overageHours, carriedOutHours: math.carriedOutHours, foreignCurrencyHours: foreign,
    entryCount: ids.length, overageInvoiceLineId, closeSource,
  };
}

/**
 * Daily close-out (#8181, plan-time amendment 4): closes the ended, claimed,
 * unclosed periods the billing run will never visit again — every block line
 * whose contract is no longer active, or that is retired. Typically the final
 * period of an advance contract, claimed on the run that expired it but not
 * ended until weeks later. Overage lands on a NEW draft invoice that is never
 * auto-issued (nothing here issues). One transaction per contract, contract row
 * locked first (the billing run's lock), so a sweep racing a manual generate or
 * another sweep closes each period exactly once; one contract's failure never
 * stops the rest.
 */
export async function runHourBlockCloseOutSweep(asOf: Date = new Date()): Promise<{ contracts: number; closes: number; errors: number }> {
  const today = asOf.toISOString().slice(0, 10);
  // Pre-filter only (the selector decides): a claimed, ended period at or after
  // the block's first period, claimed while the line was live, with no ledger row.
  const candidates = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.selectDistinct({ contractId: contractLines.contractId }).from(contractLines)
      .innerJoin(contracts, eq(contracts.id, contractLines.contractId))
      .where(and(
        eq(contractLines.lineType, 'hour_block'),
        or(ne(contracts.status, 'active'), isNotNull(contractLines.hourBlockRetiredAt)),
        buildAutomationEligibleOrgPredicate(contracts.orgId),
        sql`EXISTS (
          SELECT 1 FROM contract_billing_periods p
          WHERE p.contract_id = ${contractLines.contractId}
            AND p.period_start >= ${contractLines.hourBlockFirstPeriodStart}
            AND p.period_end <= ${today}::date
            AND (${contractLines.hourBlockRetiredAt} IS NULL
                 OR (p.generated_at AT TIME ZONE current_setting('TimeZone')) <= ${contractLines.hourBlockRetiredAt})
            AND NOT EXISTS (
              SELECT 1 FROM contract_hour_periods h
              WHERE h.contract_line_id = ${contractLines.id} AND h.period_start = p.period_start))`,
      ))));

  let closes = 0;
  let errors = 0;
  for (const { contractId } of candidates) {
    try {
      closes += await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
        // Same statement as contractService.lockContractRow — inlined because
        // contractService imports this module (a back-import would be a cycle).
        const [c] = await db.select().from(contracts).where(eq(contracts.id, contractId)).limit(1).for('update');
        if (!c) return 0; // deleted since the candidate read
        const actor: InvoiceActor = { userId: c.createdBy, partnerId: c.partnerId, accessibleOrgIds: [c.orgId] };
        const lines = await db.select().from(contractLines)
          .where(and(eq(contractLines.contractId, contractId), eq(contractLines.lineType, 'hour_block')))
          .orderBy(asc(contractLines.id));
        let n = 0;
        for (const line of lines) {
          // A live line on an active contract belongs to the billing run (re-read under the lock).
          if ((c.status as string) === 'active' && line.hourBlockRetiredAt === null) continue;
          const r = await closeHourBlockPeriods({
            contract: c, line, closeSource: 'close_out', asOf,
            overageInvoice: async () => {
              const inv = await createManualInvoice({
                orgId: c.orgId, currencyCode: c.currencyCode,
                notes: `Block hours over the included amount on contract "${c.name}"`,
              }, actor);
              return { id: inv.id, actor };
            },
          });
          n += r.closes.length;
          if (r.truncated) {
            console.warn('[contractHourBlocks] close-out backlog capped; remaining periods close on later sweeps',
              { contractId, lineId: line.id });
          }
        }
        return n;
      }));
    } catch (err) {
      errors += 1;
      console.error('[contractHourBlocks] close-out failed', `contractId=${contractId}`, err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { contracts: candidates.length, closes, errors };
}
