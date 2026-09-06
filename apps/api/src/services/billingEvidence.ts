/**
 * #3205 W07 (#4656) — reading the billing evidence written at generation.
 *
 * Both entry points re-assert org access against the PARENT document and throw
 * 404 (never 403) on a mismatch, matching getInvoice/getCustomerInvoice. Both
 * also assert SAME-PARENT ownership in the SQL predicate rather than after the
 * fetch, so a valid line id from a different invoice in the same org is a 404
 * and never a read of someone else's evidence through a mismatched path.
 */
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  invoiceLineDevices, invoiceLines, contractBillingPeriods, contractBillingPeriodOutcomes,
} from '../db/schema';
import { getOwnedInvoiceOr404, requireInvoiceAccess } from './invoiceService';
import { getOwnedContractOr404, type OverageSummary } from './contractService';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { ContractServiceError, type ContractActor } from './contractTypes';
import type { InvoiceLineDeviceCountedAs } from '@breeze/shared';

export const INVOICE_LINE_DEVICES_MAX_LIMIT = 500;
export const INVOICE_LINE_DEVICES_DEFAULT_LIMIT = 100;

export interface InvoiceLineDeviceRow {
  /** The evidence row's own id: stable even for detached duplicate hostnames. */
  id: string;
  deviceId: string | null;
  hostname: string;
  deviceRole: string;
  siteId: string | null;
  countedAs: InvoiceLineDeviceCountedAs;
}

/** base64url of `hostname + NUL + id`. A NUL byte cannot occur in a hostname,
 * so the split is unambiguous for every legal value. */
const CURSOR_SEP = '\u0000';

function encodeCursor(hostname: string, id: string): string {
  return Buffer.from(hostname + CURSOR_SEP + id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { hostname: string; id: string } {
  const bytes = Buffer.from(cursor, 'base64url');
  const raw = bytes.toString('utf8');
  const at = raw.indexOf(CURSOR_SEP);
  const id = at === -1 ? '' : raw.slice(at + 1);
  // Buffer's base64url decoder is intentionally permissive, so require a
  // canonical round trip as well as the expected payload shape.
  if (
    bytes.toString('base64url') !== cursor
    || at === -1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new InvoiceServiceError('Invalid cursor', 400, 'INVALID_CURSOR');
  }
  return { hostname: raw.slice(0, at), id };
}

export async function listInvoiceLineDevices(
  invoiceId: string,
  lineId: string,
  opts: { limit: number; cursor?: string },
  actor: InvoiceActor,
): Promise<{ recorded: boolean; total: number; devices: InvoiceLineDeviceRow[]; nextCursor: string | null }> {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  requireInvoiceAccess(actor, inv);

  // The parent relation belongs in SQL: do not fetch a line by id and inspect
  // invoiceId afterward.
  const [line] = await db.select({ id: invoiceLines.id }).from(invoiceLines)
    .where(and(eq(invoiceLines.id, lineId), eq(invoiceLines.invoiceId, invoiceId))).limit(1);
  if (!line) {
    throw new InvoiceServiceError('Invoice line not found', 404, 'INVOICE_LINE_NOT_FOUND');
  }

  const limit = Math.min(Math.max(1, opts.limit), INVOICE_LINE_DEVICES_MAX_LIMIT);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;

  const [totals] = await db.select({ n: count() }).from(invoiceLineDevices)
    .where(eq(invoiceLineDevices.invoiceLineId, lineId));

  const rows = await db.select({
    id: invoiceLineDevices.id,
    deviceId: invoiceLineDevices.deviceId,
    hostname: invoiceLineDevices.hostname,
    deviceRole: invoiceLineDevices.deviceRole,
    siteId: invoiceLineDevices.siteId,
    countedAs: invoiceLineDevices.countedAs,
  }).from(invoiceLineDevices)
    .where(and(
      eq(invoiceLineDevices.invoiceLineId, lineId),
      cursor
        // COLLATE "C" (UTF-8 byte order) matches the UTF-16 code-unit order
        // orderDevicesForEvidence uses for BMP hostnames; non-BMP characters may
        // differ. The UUID tie-breaker makes the keyset total.
        ? sql`(${invoiceLineDevices.hostname} COLLATE "C", ${invoiceLineDevices.id}) > (${cursor.hostname} COLLATE "C", ${cursor.id}::uuid)`
        : undefined,
    ))
    .orderBy(sql`${invoiceLineDevices.hostname} COLLATE "C"`, asc(invoiceLineDevices.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    // Invoice-level by design: a recorded line may legitimately have no rows.
    recorded: inv.evidenceVersion !== null,
    total: Number(totals?.n ?? 0),
    devices: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.hostname, last.id) : null,
  };
}

export interface PeriodOutcome {
  contractBillingPeriodId: string;
  invoiceId: string | null;
  snapshotDeviceTotal: number;
  uncoveredTotal: number;
  flaggedTotal: number;
  billedOverageTotal: number;
  uncoveredByRole: Record<string, number>;
  overages: OverageSummary[];
  generatedAt: string;
}

export async function getPeriodOutcome(
  contractId: string,
  periodId: string,
  actor: ContractActor,
): Promise<{ recorded: boolean; outcome: PeriodOutcome | null }> {
  await getOwnedContractOr404(contractId, actor);
  const [period] = await db.select({ id: contractBillingPeriods.id }).from(contractBillingPeriods)
    .where(and(
      eq(contractBillingPeriods.id, periodId),
      eq(contractBillingPeriods.contractId, contractId),
    )).limit(1);
  if (!period) {
    throw new ContractServiceError('Billing period not found', 404, 'PERIOD_NOT_FOUND');
  }

  const [row] = await db.select().from(contractBillingPeriodOutcomes)
    .where(eq(contractBillingPeriodOutcomes.contractBillingPeriodId, periodId)).limit(1);
  if (!row) return { recorded: false, outcome: null };

  return {
    recorded: true,
    outcome: {
      contractBillingPeriodId: row.contractBillingPeriodId,
      invoiceId: row.invoiceId,
      snapshotDeviceTotal: row.snapshotDeviceTotal,
      uncoveredTotal: row.uncoveredTotal,
      flaggedTotal: row.flaggedTotal,
      billedOverageTotal: row.billedOverageTotal,
      uncoveredByRole: (row.uncoveredByRole ?? {}) as Record<string, number>,
      overages: (row.overages ?? []) as OverageSummary[],
      generatedAt: row.generatedAt.toISOString(),
    },
  };
}
