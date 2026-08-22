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

export function timeEntryToLineSpec(r: {
  id: string; ticketId: string | null; description: string | null;
  durationMinutes: number | null; hourlyRate: string | null; isApproved: boolean;
}, currencyCode = 'USD'): DraftLineSpec {
  const hours = ((r.durationMinutes ?? 0) / 60).toFixed(2);
  const unitPrice = r.hourlyRate != null ? Number(r.hourlyRate).toFixed(2) : '0.00';
  return {
    sourceType: 'time_entry', sourceId: r.id, catalogItemId: null, ticketId: r.ticketId,
    description: r.description?.trim() || 'Labor',
    quantity: hours, unitPrice, costBasis: null, taxable: false, customerVisible: true,
    lineTotal: computeLineTotal(hours, unitPrice, currencyCode), isUnapprovedTime: !r.isApproved
  };
}

export function ticketPartToLineSpec(r: {
  id: string; ticketId: string | null; catalogItemId: string | null; description: string;
  quantity: string; unitPrice: string; costBasis: string | null;
}, currencyCode = 'USD'): DraftLineSpec {
  return {
    sourceType: 'part', sourceId: r.id, catalogItemId: r.catalogItemId, ticketId: r.ticketId,
    description: r.description,
    quantity: r.quantity, unitPrice: r.unitPrice, costBasis: r.costBasis ?? null,
    taxable: true, customerVisible: true,
    lineTotal: computeLineTotal(r.quantity, r.unitPrice, currencyCode), isUnapprovedTime: false
  };
}

/** Unbilled billable time entries for an org within [from, to] (by ended_at).
 *  `currencyCode` is the currency of the draft invoice the specs will land on —
 *  line totals must be rounded at that currency's minor unit (JPY → whole units). */
export async function gatherOrgTimeEntries(orgId: string, from: Date, to: Date, currencyCode = 'USD'): Promise<DraftLineSpec[]> {
  const rows = await db.select({
    id: timeEntries.id, ticketId: timeEntries.ticketId, description: timeEntries.description,
    durationMinutes: timeEntries.durationMinutes, hourlyRate: timeEntries.hourlyRate, isApproved: timeEntries.isApproved
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
  return rows.map((r) => timeEntryToLineSpec(r, currencyCode));
}

/** Unbilled billable ticket parts for an org within [from, to] (by created_at).
 *  `currencyCode`: see gatherOrgTimeEntries. */
export async function gatherOrgParts(orgId: string, from: Date, to: Date, currencyCode = 'USD'): Promise<DraftLineSpec[]> {
  const rows = await db.select({
    id: ticketParts.id, ticketId: ticketParts.ticketId, catalogItemId: ticketParts.catalogItemId,
    description: ticketParts.description, quantity: ticketParts.quantity, unitPrice: ticketParts.unitPrice, costBasis: ticketParts.costBasis
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
  return rows.map((r) => ticketPartToLineSpec(r, currencyCode));
}

/** Per-ticket: all unbilled billable time + parts for one ticket.
 *  `currencyCode`: see gatherOrgTimeEntries. */
export async function gatherTicketBillables(ticketId: string, currencyCode = 'USD'): Promise<DraftLineSpec[]> {
  const te = await db.select({
    id: timeEntries.id, ticketId: timeEntries.ticketId, description: timeEntries.description,
    durationMinutes: timeEntries.durationMinutes, hourlyRate: timeEntries.hourlyRate, isApproved: timeEntries.isApproved
  }).from(timeEntries).where(and(
    eq(timeEntries.ticketId, ticketId), eq(timeEntries.isBillable, true), eq(timeEntries.billingStatus, 'not_billed'),
    // Explicit exclusions (redundant with = 'not_billed', kept for intent/future-proofing).
    ne(timeEntries.billingStatus, 'contract'), ne(timeEntries.billingStatus, 'no_charge'),
    sql`${timeEntries.endedAt} IS NOT NULL`
  ));
  const parts = await db.select({
    id: ticketParts.id, ticketId: ticketParts.ticketId, catalogItemId: ticketParts.catalogItemId,
    description: ticketParts.description, quantity: ticketParts.quantity, unitPrice: ticketParts.unitPrice, costBasis: ticketParts.costBasis
  }).from(ticketParts).where(and(
    eq(ticketParts.ticketId, ticketId), eq(ticketParts.isBillable, true), eq(ticketParts.billingStatus, 'not_billed'),
    // Explicit exclusions (redundant with = 'not_billed', kept for intent/future-proofing).
    ne(ticketParts.billingStatus, 'contract'), ne(ticketParts.billingStatus, 'no_charge')
  ));
  return [...te.map((r) => timeEntryToLineSpec(r, currencyCode)), ...parts.map((r) => ticketPartToLineSpec(r, currencyCode))];
}
