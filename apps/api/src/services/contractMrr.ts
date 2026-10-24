import { and, eq, gt, inArray, lte, or } from 'drizzle-orm';
import { db } from '../db';
import { contracts, contractLines } from '../db/schema';
import { fromCents, roundToCurrency, toCents } from '@breeze/shared';
import { contractInTermForReporting, todayISO } from './contractMath';
import { loadBilledFinalTermValues, type BilledFinalTermValue } from './contractBilledFinalTerm';
import { resolvePriceFrom, isPriceGap } from './catalogPricing';
import { ContractServiceError } from './contractTypes';
import {
  baseCents, groupIdsOf, lineCents, loadCatalogPriceInputs, orgSnapshot, priceKey, resolveLineQty,
  type DeviceCache, type PriceKey, type SeatCache,
} from './contractService';

/**
 * Per-contract MRR rows (#9828 W1, business-reports phase 2 spec §3.2).
 *
 * The partner-dashboard rollup (summarizeActiveContractMrrByOrg) used to fold
 * contracts straight into per-org totals and DROP every contract it could not
 * value. The MRR & renewals report needs the per-contract figures and the drops
 * as named reasons, so the resolution now produces rows and the dashboard is a
 * fold over them. The dashboard figure is unchanged (characterization suite in
 * contractMrr.test.ts).
 *
 * Import direction: this module imports the line/price helpers from
 * contractService.ts; contractService.ts must never import this module.
 */

export type ContractMrrBasis = 'active' | 'billed_final_term' | 'paused' | 'draft';
export type ContractSkipReason =
  | 'group_evaluation_failed' | 'site_deleted'
  | 'final_term_invoice_missing' | 'final_term_invoice_voided'
  | 'final_term_reissue_chain_too_long' | 'final_term_no_contract_lines';
export type ActiveNotInTermReason = 'starts_later' | 'ended_awaiting_expiry' | 'final_period_not_billed';

export interface ContractMrrRow {
  contractId: string; orgId: string; name: string;
  status: 'active' | 'expired' | 'paused' | 'draft';
  basis: ContractMrrBasis;
  currencyCode: string; intervalMonths: number;
  /** Base leg per month. For billed_final_term: the whole billed value (= mrr), never a split. */
  baseMonthly: string;
  /** mrr − baseMonthly. Null for billed_final_term: the final term was billed as a lump. */
  overageMonthly: string | null;
  /** The contract's monthly figure, rounded in its own currency (the dashboard's per-contract term). */
  mrr: string;
  startDate: string; endDate: string | null;
  autoRenew: boolean; renewalTermMonths: number | null;
  /** A line bills a deleted device group (counted as 0). */
  unresolvedGroup: boolean;
}
export interface SkippedContract { contractId: string; orgId: string; name: string; status: string; reason: ContractSkipReason }
export interface ActiveNotInTerm {
  contractId: string; orgId: string; name: string; startDate: string; endDate: string | null; reason: ActiveNotInTermReason;
}
export interface ContractMrrRows { rows: ContractMrrRow[]; skipped: SkippedContract[]; activeNotInTerm: ActiveNotInTerm[] }

export interface OrgCurrencyMrr { currencyCode: string; amount: string }

type ContractRow = typeof contracts.$inferSelect;

const FINAL_TERM_SKIP: Record<Extract<BilledFinalTermValue, { cents: null }>['reason'], ContractSkipReason> = {
  invoice_missing: 'final_term_invoice_missing',
  invoice_voided: 'final_term_invoice_voided',
  reissue_chain_too_long: 'final_term_reissue_chain_too_long',
  no_contract_lines: 'final_term_no_contract_lines',
};

function monthsOf(c: Pick<ContractRow, 'intervalMonths'>): number {
  return c.intervalMonths > 0 ? c.intervalMonths : 1;
}

/** Period cents → per-month figure rounded in the contract's own currency (a JPY
 *  contract never contributes a fractional yen). The same arithmetic the
 *  dashboard rollup has always used. */
function monthlyOf(c: Pick<ContractRow, 'intervalMonths' | 'currencyCode'>, periodCents: number): string {
  return roundToCurrency(Number(fromCents(periodCents)) / monthsOf(c), c.currencyCode);
}

function rowFor(
  c: ContractRow, basis: ContractMrrBasis, baseMonthly: string, overageMonthly: string | null, mrr: string,
  unresolvedGroup: boolean,
): ContractMrrRow {
  return {
    contractId: c.id, orgId: c.orgId, name: c.name,
    status: c.status as ContractMrrRow['status'],
    basis, currencyCode: c.currencyCode, intervalMonths: c.intervalMonths,
    baseMonthly, overageMonthly, mrr,
    startDate: c.startDate, endDate: c.endDate ?? null,
    autoRenew: c.autoRenew, renewalTermMonths: c.renewalTermMonths ?? null,
    unresolvedGroup,
  };
}

function skip(c: ContractRow, reason: ContractSkipReason): SkippedContract {
  return { contractId: c.id, orgId: c.orgId, name: c.name, status: c.status, reason };
}

/**
 * Every contract that counts toward MRR on `asOf` as one row, plus the
 * contracts that should have counted but could not be valued (`skipped`) and
 * the `active` contracts the in-term predicate leaves out (`activeNotInTerm`).
 *
 * Eligibility is "in term" (contractInTermForReporting, #9220 / spec T8), not
 * the status stamp, which is wrong in BOTH directions:
 *  - 'active' can be over: an ended contract is flipped to 'expired' LAZILY by
 *    generateDueInvoice at its next billing date (there is no expiry reaper),
 *    so it keeps 'active' for up to a whole interval while billing already
 *    skips it via isExpired (isPastEndForReporting, same guard, same inputs).
 *  - 'expired' can be running: generateDueInvoice flips an ADVANCE contract to
 *    'expired' as soon as it bills the final period, which is paid for and
 *    still being served until end_date. Those are valued at what was billed.
 *    An AUTO-RENEWING contract is not expired then (#9243). It stays 'active'
 *    with the pointer at end_date and is valued the same way.
 * Only expired contracts whose dates still put them in term are loaded, so
 * expired history does not grow this query.
 *
 * `opts.include` adds paused and/or draft contracts, live-resolved like active
 * ones with `basis` = their status. They are never MRR; the report shows them
 * beside it. `opts.partnerId` binds contracts.partner_id as well as the org
 * allowlist (the report passes it at partner scope; RLS is only the backstop).
 * Lines, billing periods and invoices are read by this contract set's ids only.
 *
 * Catalog-backed lines are priced through the SAME resolver recurring billing
 * uses (`resolvePriceFrom`, spec §6: org override in the contract's currency →
 * price-book row for that currency → the line's stamped snapshot on a gap), so
 * the figures agree with the invoices they predict. Never converts and never
 * falls through to another currency's price.
 */
export async function resolveContractMrrRows(
  orgIds: readonly string[],
  asOf: Date,
  opts: { include?: readonly ('paused' | 'draft')[]; partnerId?: string } = {},
): Promise<ContractMrrRows> {
  const out: ContractMrrRows = { rows: [], skipped: [], activeNotInTerm: [] };
  if (orgIds.length === 0) return out;

  const asOfISO = todayISO(asOf);
  const include = [...new Set(opts.include ?? [])];
  const candidates = await db.select().from(contracts)
    .where(and(
      inArray(contracts.orgId, [...orgIds]),
      opts.partnerId !== undefined ? eq(contracts.partnerId, opts.partnerId) : undefined,
      or(
        eq(contracts.status, 'active' as never),
        and(eq(contracts.status, 'expired' as never), lte(contracts.startDate, asOfISO), gt(contracts.endDate, asOfISO)),
        ...(include.length > 0 ? [inArray(contracts.status, include as never[])] : []),
      ),
    ));
  // An expired contract, or an active one past its billing end (an auto-renewing
  // contract after its final invoice, #9243), is in term only if a billed period
  // covers asOf. Look that up only for contracts whose basis depends on it.
  const finalTermIds = candidates
    .filter((c) => contractInTermForReporting(c, asOfISO, false) === null && contractInTermForReporting(c, asOfISO, true) !== null)
    .map((c) => c.id);
  const finalTermValues = await loadBilledFinalTermValues(finalTermIds, asOfISO);

  // Billed final terms first, then the live-resolved rows: the dashboard fold
  // sums in this order, exactly as it always has.
  const live: { c: ContractRow; basis: ContractMrrBasis }[] = [];
  for (const c of candidates) {
    if (c.status === 'paused' || c.status === 'draft') { live.push({ c, basis: c.status }); continue; }
    const value = finalTermValues.get(c.id);
    const basis = contractInTermForReporting(c, asOfISO, value !== undefined);
    if (basis === 'active') { live.push({ c, basis }); continue; }
    if (basis === null) {
      if (c.status === 'active') {
        out.activeNotInTerm.push({
          contractId: c.id, orgId: c.orgId, name: c.name, startDate: c.startDate, endDate: c.endDate ?? null,
          reason: c.startDate > asOfISO ? 'starts_later'
            : c.endDate !== null && asOfISO >= c.endDate ? 'ended_awaiting_expiry'
              : 'final_period_not_billed',
        });
      }
      continue;
    }
    if (value === undefined) continue; // unreachable: billed_final_term implies a value
    if (value.cents === null) {
      console.warn('[contracts] MRR rollup skipped final term of contract %s (org %s): %s', c.id, c.orgId, value.reason);
      out.skipped.push(skip(c, FINAL_TERM_SKIP[value.reason]));
      continue;
    }
    // Gate B 5: the billed lump is never split into base and overage.
    const mrr = monthlyOf(c, value.cents);
    out.rows.push(rowFor(c, 'billed_final_term', mrr, null, mrr, false));
  }

  const allLines = live.length === 0 ? [] : await db.select().from(contractLines)
    .where(inArray(contractLines.contractId, live.map((r) => r.c.id)));
  const byContract = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const list = byContract.get(l.contractId);
    if (list) list.push(l); else byContract.set(l.contractId, [l]);
  }

  // Price-book inputs, loaded once for the whole call.
  const catalogItemIds = [...new Set(allLines.map((l) => l.catalogItemId).filter((v): v is string => !!v))];
  let overrides = new Map<string, { unitPrice: string; currencyCode: string }>();
  let bookRows = new Map<string, { unitPrice: string }>();
  if (catalogItemIds.length > 0) {
    const contractsWithCatalog = live.map((r) => r.c).filter((c) => (byContract.get(c.id) ?? []).some((l) => l.catalogItemId));
    const loaded = await loadCatalogPriceInputs(
      catalogItemIds,
      [...new Set(contractsWithCatalog.map((c) => c.orgId))],
      [...new Set(contractsWithCatalog.map((c) => c.currencyCode))],
    );
    overrides = loaded.overrides;
    bookRows = loaded.bookRows;
  }
  // Resolve once per distinct (itemId, currencyCode, orgId), like the device and
  // seat caches below.
  const priceCache = new Map<PriceKey, string | null>();
  function resolvedUnitPrice(itemId: string, currencyCode: string, orgId: string): string | null {
    const key = priceKey(itemId, currencyCode, orgId);
    if (priceCache.has(key)) return priceCache.get(key)!;
    // Only the unit price is consumed; candidate selection and representability
    // depend solely on the override/book rows and the target currency, never on
    // the item's cost snapshot — so the cost fields are stubbed rather than
    // loading every catalog item for a figure that ignores them. A gap (either
    // kind) is a null here: the caller bills the stamped snapshot, exactly as
    // addContractLine does.
    const resolved = resolvePriceFrom(
      { costBasis: null, costCurrency: currencyCode, taxable: false, taxCategory: null },
      overrides.get(`${itemId}|${orgId}`) ?? null,
      bookRows.get(`${itemId}|${currencyCode}`) ?? null,
      currencyCode,
    );
    const price = isPriceGap(resolved) ? null : resolved.unitPrice;
    priceCache.set(key, price);
    return price;
  }

  // Shared across ALL orgs in this call, so a distinct (org, site) device count
  // and a distinct org seat count each run exactly once.
  const dc: DeviceCache = new Map();
  const sc: SeatCache = new Map();

  for (const { c, basis } of live) {
    let cents = 0;
    let base = 0;
    let siteDeleted = false;
    let unresolvedGroup = false;
    try {
      const lines = byContract.get(c.id) ?? [];
      const groupIds = groupIdsOf(lines);
      if (groupIds.length > 0) await orgSnapshot(c.orgId, dc, groupIds);
      for (const l of lines) {
        const r = await resolveLineQty(c.orgId, l, dc, sc);
        if (r.unresolved === 'group_deleted') {
          unresolvedGroup = true;
          console.warn(
            '[contracts] MRR rollup: contract %s line %s bills a deleted device group (%s); counted as 0',
            c.id,
            l.id,
            l.deviceGroupName,
          );
        }
        if (r.unresolved === 'site_deleted') {
          console.warn(
            '[contracts] MRR rollup skipped contract %s: line %s bills deleted site %s',
            c.id,
            l.id,
            l.siteName,
          );
          siteDeleted = true;
          break;
        }
        const unitPrice = l.catalogItemId
          ? (resolvedUnitPrice(l.catalogItemId, c.currencyCode, c.orgId) ?? l.unitPrice)
          : l.unitPrice;
        // The BASE leg may be catalog-resolved; the overage leg never is
        // (decision 13), so lineCents reads the stamped overage_unit_price.
        cents += lineCents(r, unitPrice, l, c.currencyCode);
        base += baseCents(r, unitPrice, c.currencyCode);
      }
    } catch (err) {
      if (err instanceof ContractServiceError && err.code === 'GROUP_EVALUATION_FAILED') {
        console.warn('[contracts] MRR rollup skipped contract %s: %s', c.id, err.message);
        out.skipped.push(skip(c, 'group_evaluation_failed'));
        continue;
      }
      throw err;
    }
    if (siteDeleted) { out.skipped.push(skip(c, 'site_deleted')); continue; }
    const mrr = monthlyOf(c, cents);
    const baseMonthly = monthlyOf(c, base);
    // Exact by construction: the overage is the difference of two rounded
    // figures, so base + overage === mrr to the minor unit.
    const overageMonthly = roundToCurrency(fromCents(toCents(mrr) - toCents(baseMonthly)), c.currencyCode);
    out.rows.push(rowFor(c, basis, baseMonthly, overageMonthly, mrr, unresolvedGroup));
  }
  return out;
}

/**
 * Estimated monthly recurring revenue per org, GROUPED BY the contract's own
 * stamped currency (multi-currency spec §8: honest per-currency segmentation,
 * never a cross-currency sum). One org can legitimately hold active contracts
 * in several currencies after an org-default change — history keeps its stamp.
 *
 * "Estimated" because per_device/per_seat quantities are resolved live; the
 * figure is never persisted. No FX happens here: converting to a single
 * reporting currency is the CALLER's optional, explicitly-approximate step.
 *
 * A fold of resolveContractMrrRows over the in-term rows (`active` and
 * `billed_final_term`): per org, per currency, the sum of each contract's
 * already-rounded monthly figure, rounded once more. Skipped contracts count
 * nothing (they are logged), exactly as before the extraction (#9828).
 */
export async function summarizeActiveContractMrrByOrg(
  orgIds: readonly string[],
  asOf: Date = new Date(),
): Promise<Map<string, OrgCurrencyMrr[]>> {
  const out = new Map<string, OrgCurrencyMrr[]>();
  if (orgIds.length === 0) return out;
  const { rows } = await resolveContractMrrRows(orgIds, asOf);

  const totals = new Map<string, Map<string, number>>(); // orgId -> currency -> monthly
  for (const r of rows) {
    if (r.basis !== 'active' && r.basis !== 'billed_final_term') continue;
    const perOrg = totals.get(r.orgId) ?? new Map<string, number>();
    perOrg.set(r.currencyCode, (perOrg.get(r.currencyCode) ?? 0) + Number(r.mrr));
    totals.set(r.orgId, perOrg);
  }
  for (const [orgId, perCurrency] of totals) {
    out.set(orgId, [...perCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currencyCode, amount]) => ({ currencyCode, amount: roundToCurrency(amount, currencyCode) })));
  }
  return out;
}
