import { and, eq, ne, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import { timeEntries, ticketParts } from '../db/schema';
import { computeLineTotal } from './invoiceMath';
import type { InvoiceLineSourceType } from './invoiceTypes';

export interface DraftLineSpec {
  sourceType: InvoiceLineSourceType;
  sourceId: string | null;
  catalogItemId: string | null;
  ticketId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  costBasis: string | null;
  taxable: boolean;
  customerVisible: boolean;
  lineTotal: string;
  isUnapprovedTime: boolean;
}

/** A billable time entry that has NO hourly rate (match-or-skip found no rate in
 *  the org's currency, spec §7). It has hours but no amount, so it can never
 *  become a line — reported as an explicit gap, never billed at zero. */
export interface MissingRateSpec {
  sourceType: 'time_entry';
  sourceId: string;
  ticketId: string | null;
  description: string;
  /** Hours, 2dp (the numeric(10,2) quantity schema). */
  quantity: string;
  currencyCode: string | null;
}

/** Result of gathering billables for a draft in `headerCurrency`. */
export interface AssemblyResult {
  included: DraftLineSpec[];
  /** Keyed by source currency; rows whose snapshot ≠ header currency. Never a silent filter. */
  blockedByCurrency: Record<string, DraftLineSpec[]>;
  /** Billable time entries with a NULL rate — an assembly gap, never a zero line (review #1). */
  missingRate: MissingRateSpec[];
}

/** Defensive bucket for a time entry with a null snapshot (impossible while the CHECK holds). */
export const UNKNOWN_CURRENCY_KEY = 'UNKNOWN';

/** Split rows into header-currency specs and per-currency blocked groups. No conversion, ever:
 *  a mismatched row is reported under its own currency, never recomputed into the header's.
 *  Blocked specs are built with the row's OWN currency so their `lineTotal` rounds honestly
 *  in that currency; included specs round in the header currency. */
export function partitionByCurrency<R extends { currencyCode?: string | null }>(
  rows: R[], headerCurrency: string, toSpec: (row: R, currency: string) => DraftLineSpec
): AssemblyResult {
  const result: AssemblyResult = { included: [], blockedByCurrency: {}, missingRate: [] };
  for (const row of rows) {
    if (row.currencyCode === headerCurrency) { result.included.push(toSpec(row, headerCurrency)); continue; }
    const key = row.currencyCode ?? UNKNOWN_CURRENCY_KEY;
    (result.blockedByCurrency[key] ??= []).push(toSpec(row, row.currencyCode ?? headerCurrency));
  }
  return result;
}

export function mergeAssembly(...parts: AssemblyResult[]): AssemblyResult {
  const out: AssemblyResult = { included: [], blockedByCurrency: {}, missingRate: [] };
  for (const p of parts) {
    out.included.push(...p.included);
    out.missingRate.push(...p.missingRate);
    for (const [code, specs] of Object.entries(p.blockedByCurrency)) (out.blockedByCurrency[code] ??= []).push(...specs);
  }
  return out;
}

type TimeEntryRow = {
  id: string; ticketId: string | null; description: string | null;
  durationMinutes: number | null; hourlyRate: string | null; isApproved: boolean;
  currencyCode?: string | null;
};

const entryHours = (r: TimeEntryRow) => ((r.durationMinutes ?? 0) / 60).toFixed(2);
const entryDescription = (r: TimeEntryRow) => r.description?.trim() || 'Labor';

/** Labor rule (one rule, everywhere): hours rounded to 2dp first (the numeric(10,2) quantity
 *  schema), then `lineTotal = roundToCurrency(hours2dp × rate, currencyCode)`.
 *  20 min × 1,000 JPY = 0.33 × 1000 = 330 — never 333.
 *  A NULL rate is never a zero line: route such rows through `partitionTimeEntries`
 *  (→ `missingRate`) — reaching this with one is a programming error. An explicit
 *  '0.00' rate entered by the user IS a valid zero line. */
export function timeEntryToLineSpec(r: TimeEntryRow, currencyCode: string): DraftLineSpec {
  if (r.hourlyRate == null) {
    throw new Error(`time entry ${r.id} has no hourly rate and cannot become an invoice line`);
  }
  const hours = entryHours(r);
  const unitPrice = Number(r.hourlyRate).toFixed(2);
  return {
    sourceType: 'time_entry', sourceId: r.id, catalogItemId: null, ticketId: r.ticketId,
    description: entryDescription(r),
    quantity: hours, unitPrice, costBasis: null, taxable: false, customerVisible: true,
    lineTotal: computeLineTotal(hours, unitPrice, currencyCode), isUnapprovedTime: !r.isApproved
  };
}

/** Time-entry partition: a NULL `hourlyRate` (default-billable entry whose
 *  match-or-skip rate lookup found nothing in the org's currency) is an explicit
 *  `missingRate` gap — it has hours but no amount, so it is neither included
 *  (would bill at zero and get marked billed) nor currency-blocked (there is no
 *  amount to report). Rated rows partition by currency as usual. */
export function partitionTimeEntries(rows: TimeEntryRow[], headerCurrency: string): AssemblyResult {
  const rated: TimeEntryRow[] = [];
  const missingRate: MissingRateSpec[] = [];
  for (const r of rows) {
    if (r.hourlyRate == null) {
      missingRate.push({
        sourceType: 'time_entry', sourceId: r.id, ticketId: r.ticketId,
        description: entryDescription(r), quantity: entryHours(r), currencyCode: r.currencyCode ?? null
      });
    } else {
      rated.push(r);
    }
  }
  const result = partitionByCurrency(rated, headerCurrency, timeEntryToLineSpec);
  result.missingRate = missingRate;
  return result;
}

export function ticketPartToLineSpec(r: {
  id: string; ticketId: string | null; catalogItemId: string | null; description: string;
  quantity: string; unitPrice: string; costBasis: string | null;
  currencyCode?: string | null;
}, currencyCode: string): DraftLineSpec {
  return {
    sourceType: 'part', sourceId: r.id, catalogItemId: r.catalogItemId, ticketId: r.ticketId,
    description: r.description,
    quantity: r.quantity, unitPrice: r.unitPrice, costBasis: r.costBasis ?? null,
    taxable: true, customerVisible: true,
    lineTotal: computeLineTotal(r.quantity, r.unitPrice, currencyCode), isUnapprovedTime: false
  };
}

/** Unbilled billable time entries for an org within [from, to] (by ended_at).
 *  `headerCurrency` is the currency of the draft invoice the specs will land on —
 *  rows whose snapshot `currency_code` differs are returned under `blockedByCurrency`
 *  (never converted, never silently dropped); included line totals round at the
 *  header currency's minor unit (JPY → whole units). */
export async function gatherOrgTimeEntries(orgId: string, from: Date, to: Date, headerCurrency: string): Promise<AssemblyResult> {
  const rows = await db.select({
    id: timeEntries.id, ticketId: timeEntries.ticketId, description: timeEntries.description,
    durationMinutes: timeEntries.durationMinutes, hourlyRate: timeEntries.hourlyRate, isApproved: timeEntries.isApproved,
    currencyCode: timeEntries.currencyCode
  }).from(timeEntries).where(and(
    eq(timeEntries.orgId, orgId),
    eq(timeEntries.isBillable, true),
    eq(timeEntries.billingStatus, 'not_billed'),
    // Explicit exclusions (redundant with = 'not_billed', kept for intent/future-proofing).
    ne(timeEntries.billingStatus, 'contract'),
    ne(timeEntries.billingStatus, 'no_charge'),
    sql`${timeEntries.endedAt} IS NOT NULL`,
    gte(timeEntries.endedAt, from),
    lte(timeEntries.endedAt, to)
  ));
  return partitionTimeEntries(rows, headerCurrency);
}

/** Unbilled billable ticket parts for an org within [from, to] (by created_at).
 *  `headerCurrency`: see gatherOrgTimeEntries. */
export async function gatherOrgParts(orgId: string, from: Date, to: Date, headerCurrency: string): Promise<AssemblyResult> {
  const rows = await db.select({
    id: ticketParts.id, ticketId: ticketParts.ticketId, catalogItemId: ticketParts.catalogItemId,
    description: ticketParts.description, quantity: ticketParts.quantity, unitPrice: ticketParts.unitPrice, costBasis: ticketParts.costBasis,
    currencyCode: ticketParts.currencyCode
  }).from(ticketParts).where(and(
    eq(ticketParts.orgId, orgId),
    eq(ticketParts.isBillable, true),
    eq(ticketParts.billingStatus, 'not_billed'),
    // Explicit exclusions (redundant with = 'not_billed', kept for intent/future-proofing).
    ne(ticketParts.billingStatus, 'contract'),
    ne(ticketParts.billingStatus, 'no_charge'),
    gte(ticketParts.createdAt, from),
    lte(ticketParts.createdAt, to)
  ));
  return partitionByCurrency(rows, headerCurrency, ticketPartToLineSpec);
}

/** Per-ticket: all unbilled billable time + parts for one ticket.
 *  `headerCurrency`: see gatherOrgTimeEntries. */
export async function gatherTicketBillables(ticketId: string, headerCurrency: string): Promise<AssemblyResult> {
  const te = await db.select({
    id: timeEntries.id, ticketId: timeEntries.ticketId, description: timeEntries.description,
    durationMinutes: timeEntries.durationMinutes, hourlyRate: timeEntries.hourlyRate, isApproved: timeEntries.isApproved,
    currencyCode: timeEntries.currencyCode
  }).from(timeEntries).where(and(
    eq(timeEntries.ticketId, ticketId), eq(timeEntries.isBillable, true), eq(timeEntries.billingStatus, 'not_billed'),
    // Explicit exclusions (redundant with = 'not_billed', kept for intent/future-proofing).
    ne(timeEntries.billingStatus, 'contract'), ne(timeEntries.billingStatus, 'no_charge'),
    sql`${timeEntries.endedAt} IS NOT NULL`
  ));
  const parts = await db.select({
    id: ticketParts.id, ticketId: ticketParts.ticketId, catalogItemId: ticketParts.catalogItemId,
    description: ticketParts.description, quantity: ticketParts.quantity, unitPrice: ticketParts.unitPrice, costBasis: ticketParts.costBasis,
    currencyCode: ticketParts.currencyCode
  }).from(ticketParts).where(and(
    eq(ticketParts.ticketId, ticketId), eq(ticketParts.isBillable, true), eq(ticketParts.billingStatus, 'not_billed'),
    // Explicit exclusions (redundant with = 'not_billed', kept for intent/future-proofing).
    ne(ticketParts.billingStatus, 'contract'), ne(ticketParts.billingStatus, 'no_charge')
  ));
  return mergeAssembly(
    partitionTimeEntries(te, headerCurrency),
    partitionByCurrency(parts, headerCurrency, ticketPartToLineSpec)
  );
}
