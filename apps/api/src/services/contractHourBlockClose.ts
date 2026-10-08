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
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { assertInTransaction, db } from '../db';
import { contractBillingPeriods, contractHourPeriods, contractLines, contracts, timeEntries } from '../db/schema';
import { addContractLine } from './invoiceService';
import type { InvoiceActor } from './invoiceTypes';
import { ContractServiceError } from './contractTypes';
import {
  computePeriodMath, selectClosablePeriods, sumEntryHours, type ClosablePeriod, type RolloverPolicy,
} from './contractHourBlocks';

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

/** Period boundary instant: UTC midnight of the ISO date, half-open [start, end). */
const dayStart = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
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
