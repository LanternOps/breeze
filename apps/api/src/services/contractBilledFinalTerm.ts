import { and, gt, inArray, isNull, lte } from 'drizzle-orm';
import { db } from '../db';
import { contractBillingPeriods, contractHourPeriods, invoiceLines, invoices } from '../db/schema';
import { toCents } from '@breeze/shared';

/**
 * #9220 (spec #9218 trap T8): the billed value of a contract in its
 * `billed_final_term` — `expired` by generateDueInvoice, but with a billed
 * contract_billing_periods row still covering asOf.
 *
 * Valued from what was actually BILLED for the covering period, never by live
 * re-resolution: the same expiry runs retireLiveHourBlocks, so a live resolve
 * would value a block fee at 0. The value is
 *   Σ top-level invoice_lines.line_total with source_contract_id = the contract,
 *   on the period's invoice (following void → reissued replacement),
 *   excluding the block-hours overage line(s) closeHourBlockPeriods put on that
 *   invoice — usage for an earlier period, not recurring revenue, and the live
 *   rollup never counts it either. Such a line is identified by its
 *   contract_hour_periods row (overage_invoice_id on the chain): same
 *   contract line (source_id), same hours (quantity), same rate (unit_price).
 *   A line an operator removed from the draft is simply not there to exclude.
 *
 * Returned map, per contract id:
 *  - key absent: no billed period covers asOf → the contract is not in term;
 *  - `{ cents }`: the covering period's billed value in integer minor-unit×100
 *    (the toCents convention), not yet divided by interval_months;
 *  - `{ cents: null, reason }`: a period covers asOf but its invoice is gone
 *    (deleted draft → invoice_id SET NULL) or voided without a replacement, so
 *    there is no billed amount to report. The caller logs and counts nothing.
 */
export type BilledFinalTermValue =
  | { cents: number }
  | { cents: null; reason: 'invoice_missing' | 'invoice_voided' };

/** A void → reissue chain longer than this is treated as unresolvable. */
const MAX_REISSUE_HOPS = 10;

export async function loadBilledFinalTermValues(
  contractIds: readonly string[],
  asOfISO: string,
): Promise<Map<string, BilledFinalTermValue>> {
  const out = new Map<string, BilledFinalTermValue>();
  if (contractIds.length === 0) return out;

  // Periods are half-open [period_start, period_end) and never overlap for one
  // contract (UNIQUE (contract_id, period_start), contiguous computePeriod), so
  // at most one row covers asOf.
  const periods = await db.select({
    contractId: contractBillingPeriods.contractId,
    invoiceId: contractBillingPeriods.invoiceId,
  }).from(contractBillingPeriods).where(and(
    inArray(contractBillingPeriods.contractId, [...contractIds]),
    lte(contractBillingPeriods.periodStart, asOfISO),
    gt(contractBillingPeriods.periodEnd, asOfISO),
  ));
  if (periods.length === 0) return out;

  // Resolve each period's invoice to the live one: a voided invoice that was
  // reissued points at its replacement draft (reissue copies the lines,
  // source_contract_id included).
  const chainOf = new Map<string, string[]>(); // contractId -> invoice ids visited, period invoice first
  const liveInvoiceOf = new Map<string, string>(); // contractId -> resolved invoice id
  const pending = new Map<string, string>(); // contractId -> invoice id still to look up
  for (const p of periods) {
    if (!p.invoiceId) { out.set(p.contractId, { cents: null, reason: 'invoice_missing' }); continue; }
    chainOf.set(p.contractId, [p.invoiceId]);
    pending.set(p.contractId, p.invoiceId);
  }
  for (let hop = 0; pending.size > 0; hop++) {
    const rows = await db.select({
      id: invoices.id, status: invoices.status, replacedByInvoiceId: invoices.replacedByInvoiceId,
    }).from(invoices).where(inArray(invoices.id, [...new Set(pending.values())]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [contractId, invoiceId] of [...pending]) {
      pending.delete(contractId);
      const inv = byId.get(invoiceId);
      if (!inv) { out.set(contractId, { cents: null, reason: 'invoice_missing' }); continue; }
      if ((inv.status as string) !== 'void') { liveInvoiceOf.set(contractId, invoiceId); continue; }
      if (!inv.replacedByInvoiceId || hop + 1 >= MAX_REISSUE_HOPS) {
        out.set(contractId, { cents: null, reason: 'invoice_voided' });
        continue;
      }
      chainOf.get(contractId)!.push(inv.replacedByInvoiceId);
      pending.set(contractId, inv.replacedByInvoiceId);
    }
  }
  if (liveInvoiceOf.size === 0) return out;

  const billedIds = [...liveInvoiceOf.keys()];
  const lines = await db.select({
    invoiceId: invoiceLines.invoiceId,
    sourceContractId: invoiceLines.sourceContractId,
    sourceId: invoiceLines.sourceId,
    quantity: invoiceLines.quantity,
    unitPrice: invoiceLines.unitPrice,
    lineTotal: invoiceLines.lineTotal,
  }).from(invoiceLines).where(and(
    inArray(invoiceLines.invoiceId, [...new Set(liveInvoiceOf.values())]),
    inArray(invoiceLines.sourceContractId, billedIds),
    isNull(invoiceLines.parentLineId),
  ));

  const chainInvoiceIds = [...new Set(billedIds.flatMap((id) => chainOf.get(id) ?? []))];
  const blockOverage = await db.select({
    contractId: contractHourPeriods.contractId,
    contractLineId: contractHourPeriods.contractLineId,
    overageInvoiceId: contractHourPeriods.overageInvoiceId,
    overageHours: contractHourPeriods.overageHours,
    overageUnitPrice: contractHourPeriods.overageUnitPrice,
  }).from(contractHourPeriods).where(and(
    inArray(contractHourPeriods.contractId, billedIds),
    inArray(contractHourPeriods.overageInvoiceId, chainInvoiceIds),
  ));

  // Each closed block-hours period billed at most ONE overage line; consume a
  // match once so a coincidentally identical second line still counts.
  const overageToExclude = blockOverage.filter((h) =>
    h.overageInvoiceId !== null && (chainOf.get(h.contractId) ?? []).includes(h.overageInvoiceId));
  const isBlockOverageLine = (l: (typeof lines)[number]): boolean => {
    const i = overageToExclude.findIndex((h) =>
      h.contractId === l.sourceContractId
      && h.contractLineId === l.sourceId
      && toCents(h.overageHours) === toCents(l.quantity)
      && toCents(h.overageUnitPrice) === toCents(l.unitPrice));
    if (i === -1) return false;
    overageToExclude.splice(i, 1);
    return true;
  };

  const cents = new Map<string, number>(billedIds.map((id) => [id, 0]));
  for (const l of lines) {
    if (!l.sourceContractId || liveInvoiceOf.get(l.sourceContractId) !== l.invoiceId) continue;
    if (isBlockOverageLine(l)) continue;
    cents.set(l.sourceContractId, cents.get(l.sourceContractId)! + toCents(l.lineTotal));
  }
  for (const [contractId, value] of cents) out.set(contractId, { cents: value });
  return out;
}
