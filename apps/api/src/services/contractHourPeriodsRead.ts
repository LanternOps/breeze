import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { contractHourPeriods } from '../db/schema';
import { getOwnedContractOr404, requireWholeContractSiteAccess } from './contractService';
import type { ContractActor } from './contractTypes';

export interface HourPeriodRow {
  id: string; contractLineId: string; periodStart: string; periodEnd: string;
  includedHours: string; carriedInHours: string; consumedHours: string; overageHours: string; carriedOutHours: string;
  foreignCurrencyHours: string; entryCount: number; overageUnitPrice: string; currencyCode: string;
  overageInvoiceId: string | null; closeSource: 'billing_run' | 'close_out'; closedAt: string;
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const encodeHourPeriodCursor = (periodStart: string, id: string): string => `${periodStart}|${id}`;
export function decodeHourPeriodCursor(raw: string): { periodStart: string; id: string } | null {
  const m = CURSOR_RE.exec(raw);
  return m ? { periodStart: m[1]!, id: m[2]! } : null;
}

/** Closed periods of a contract's block line(s), newest first. Org-axis table, so
 *  the ordinary request context is enough (unlike time_entries). */
export async function listContractHourPeriods(
  contractId: string, query: { limit: number; cursor?: string }, actor: ContractActor,
): Promise<{ items: HourPeriodRow[]; nextCursor: string | null }> {
  await getOwnedContractOr404(contractId, actor);               // 404 + org access
  await requireWholeContractSiteAccess(actor, contractId);       // no-op for an unrestricted actor
  const conds = [eq(contractHourPeriods.contractId, contractId)];
  const cur = query.cursor ? decodeHourPeriodCursor(query.cursor) : null;
  if (query.cursor && !cur) return { items: [], nextCursor: null };   // the route validates; defence in depth
  if (cur) {
    conds.push(sql`(${contractHourPeriods.periodStart}, ${contractHourPeriods.id}) < (${cur.periodStart}::date, ${cur.id}::uuid)`);
  }
  const rows = await db.select().from(contractHourPeriods).where(and(...conds))
    .orderBy(desc(contractHourPeriods.periodStart), desc(contractHourPeriods.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const items: HourPeriodRow[] = page.map((r) => ({
    id: r.id, contractLineId: r.contractLineId, periodStart: r.periodStart, periodEnd: r.periodEnd,
    includedHours: r.includedHours, carriedInHours: r.carriedInHours, consumedHours: r.consumedHours,
    overageHours: r.overageHours, carriedOutHours: r.carriedOutHours, foreignCurrencyHours: r.foreignCurrencyHours,
    entryCount: r.entryCount, overageUnitPrice: r.overageUnitPrice, currencyCode: r.currencyCode,
    overageInvoiceId: r.overageInvoiceId, closeSource: r.closeSource as HourPeriodRow['closeSource'],
    closedAt: new Date(r.closedAt).toISOString(),
  }));
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > query.limit && last ? encodeHourPeriodCursor(last.periodStart, last.id) : null,
  };
}
