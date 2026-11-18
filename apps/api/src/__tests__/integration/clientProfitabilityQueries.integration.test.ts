/**
 * #9828 W3 Task 3.1 — the client-profitability statements against REAL
 * Postgres. The SQL fold must equal the TypeScript reference fold
 * (services/__testutils__/clientProfitabilityReferenceFold.ts, itself proven
 * equal to the invoice margin panel by clientProfitability.parity.test.ts)
 * over real seeded lines: a visible-component bundle, a partial-cost bundle,
 * an all-labor invoice, an hour-block overage contract line, a product line
 * written by the real quote-accept path (cost stamped by #9221), hidden lines,
 * and draft / void / out-of-period invoices that must contribute nothing.
 *
 * Statements run under SYSTEM scope on purpose: RLS would admit everything
 * there, so a foreign row that stays out proves the explicit predicate is the
 * fence. One statement repeats under the partner's RLS context for parity.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, inArray } from 'drizzle-orm';
import { multiplyToCurrency } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { invoiceLines, invoices, timeEntries } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { issueInvoice } from '../../services/invoiceService';
import { addCatalogLine, createQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';
import {
  hoursQuery,
  invoiceDetailQuery,
  invoiceLineFoldQuery,
  localPeriodDates,
  type HoursRow,
  type LineFoldRow,
} from '../../services/businessReports/clientProfitabilityQueries';
import { rowsOf } from '../../services/businessReports/common';
import { resolveReportPeriod } from '../../services/businessReports/period';
import { referenceFold, type ReferenceLine } from '../../services/__testutils__/clientProfitabilityReferenceFold';
import { createCatalogItemWithPrice, createOrganization, createPartner } from './db-utils';
import { seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
const AUGUST = { periodStartDate: '2026-08-01', periodEndDate: '2026-09-01' };
let seq = 0;

async function seedInvoice(f: BlockFixture, o: { status: 'draft' | 'sent' | 'partially_paid' | 'overdue' | 'paid' | 'void'; issueDate: string | null }) {
  const [inv] = await getTestDb().insert(invoices).values({
    partnerId: f.partnerId, orgId: f.orgId, currencyCode: f.currency, status: o.status, issueDate: o.issueDate,
    invoiceNumber: o.status === 'draft' ? null : `CP-${Date.now()}-${++seq}`,
  } as never).returning({ id: invoices.id });
  return inv!.id;
}

type LineSeed = {
  sourceType: ReferenceLine['sourceType']; quantity: string; unitPrice: string; costBasis: string | null;
  customerVisible?: boolean; parentLineId?: string | null; catalogItemId?: string | null;
};

async function seedLine(f: BlockFixture, invoiceId: string, l: LineSeed): Promise<string> {
  const lineTotal = multiplyToCurrency(l.quantity, l.unitPrice, f.currency);
  const [row] = await getTestDb().insert(invoiceLines).values({
    invoiceId, orgId: f.orgId, sourceType: l.sourceType, description: `${l.sourceType} line`,
    quantity: l.quantity, unitPrice: l.unitPrice, costBasis: l.costBasis, lineTotal,
    customerVisible: l.customerVisible ?? true, parentLineId: l.parentLineId ?? null,
    catalogItemId: l.catalogItemId ?? null, taxable: false, sortOrder: ++seq,
  } as never).returning({ id: invoiceLines.id });
  return row!.id;
}

/** July fee; 11 h logged in July (1 over the block); August invoice = fee + July overage. Both issued. */
async function seedContractInvoices(f: BlockFixture): Promise<{ july: string; august: string }> {
  const run = (d: string) => withSystemDbAccessContext(() => generateDueInvoice(f.contractId, new Date(`${d}T06:00:00Z`)));
  const july = (await run('2026-07-01')).invoiceId!;
  await seedEntry(f, { minutes: 660, endedAt: '2026-07-20T12:00:00Z' });
  const august = (await run('2026-08-01')).invoiceId!;
  for (const id of [july, august]) await withSystemDbAccessContext(() => issueInvoice(id, f.actor as never));
  await getTestDb().update(invoices).set({ issueDate: '2026-07-01' }).where(eq(invoices.id, july));
  await getTestDb().update(invoices).set({ issueDate: '2026-08-01' }).where(eq(invoices.id, august));
  return { july, august };
}

/** A catalog product sold through a real quote acceptance (#9221 stamps cost_basis). */
async function seedAcceptedProduct(f: BlockFixture): Promise<string> {
  const item = await withSystemDbAccessContext(() => createCatalogItemWithPrice({
    partnerId: f.partnerId, name: 'Firewall', currencyCode: f.currency, unitPrice: '500.00', costBasis: '300.00', itemType: 'hardware',
  }));
  const ctx = { scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: null } as never;
  const actor = { userId: null, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
  const quote = await withDbAccessContext(ctx, () => createQuote({ orgId: f.orgId, currencyCode: f.currency } as never, actor));
  await withDbAccessContext(ctx, () => addCatalogLine(quote.id, item.id, 1, undefined, actor));
  await withDbAccessContext(ctx, () => sendQuote(quote.id, actor));
  const res = await withDbAccessContext(ctx, () => acceptQuote({ quoteId: quote.id, signerName: 'Pat Buyer' }));
  await getTestDb().update(invoices).set({ issueDate: '2026-08-20' }).where(eq(invoices.id, res.invoiceId));
  return res.invoiceId;
}

type Seeded = { f: BlockFixture; inPeriod: string[]; excluded: string[]; overageLineId: string };

async function seedAll(currency = 'USD'): Promise<Seeded> {
  const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-12-01', currency });
  const { july, august } = await seedContractInvoices(f);
  const augustLines = await getTestDb().select().from(invoiceLines).where(eq(invoiceLines.invoiceId, august));
  const overage = augustLines.find((l) => l.sourceType === 'contract' && l.unitPrice === '150.00');
  expect(overage).toBeDefined();

  // Products, a visible-component bundle, a partial-cost bundle, hidden and 0-cost lines.
  const goods = await seedInvoice(f, { status: 'paid', issueDate: '2026-08-10' });
  await seedLine(f, goods, { sourceType: 'catalog', quantity: '2.00', unitPrice: '120.00', costBasis: '80.00' });
  const bundle = await seedLine(f, goods, { sourceType: 'bundle', quantity: '1.00', unitPrice: '500.00', costBasis: '320.00' });
  await seedLine(f, goods, { sourceType: 'catalog', parentLineId: bundle, quantity: '1.00', unitPrice: '0.00', costBasis: '200.00' });
  await seedLine(f, goods, { sourceType: 'catalog', parentLineId: bundle, quantity: '2.00', unitPrice: '0.00', costBasis: '60.00' });
  const partial = await seedLine(f, goods, { sourceType: 'bundle', quantity: '1.00', unitPrice: '400.00', costBasis: '150.00' });
  await seedLine(f, goods, { sourceType: 'catalog', parentLineId: partial, quantity: '1.00', unitPrice: '0.00', costBasis: '150.00', customerVisible: false });
  await seedLine(f, goods, { sourceType: 'catalog', parentLineId: partial, quantity: '1.00', unitPrice: '0.00', costBasis: null, customerVisible: false });
  await seedLine(f, goods, { sourceType: 'manual', quantity: '1.00', unitPrice: '75.00', costBasis: null, customerVisible: false });
  await seedLine(f, goods, { sourceType: 'manual', quantity: '1.00', unitPrice: '60.00', costBasis: '0.00' });
  await seedLine(f, goods, { sourceType: 'ai_usage', quantity: '1.00', unitPrice: '12.34', costBasis: null });
  await seedLine(f, goods, { sourceType: 'manual', quantity: '1.50', unitPrice: '0.03', costBasis: '0.01' }); // half-cent tie

  // An all-labor invoice, issued on the local last day of the period.
  const labor = await seedInvoice(f, { status: 'overdue', issueDate: '2026-08-31' });
  await seedLine(f, labor, { sourceType: 'time_entry', quantity: '1.50', unitPrice: '95.00', costBasis: null });
  await seedLine(f, labor, { sourceType: 'time_entry', quantity: '0.25', unitPrice: '95.00', costBasis: null });

  const accepted = await seedAcceptedProduct(f);

  // Must contribute nothing: draft, void, the day after the period.
  const draft = await seedInvoice(f, { status: 'draft', issueDate: '2026-08-12' });
  await seedLine(f, draft, { sourceType: 'catalog', quantity: '1.00', unitPrice: '999.00', costBasis: '1.00' });
  const voided = await seedInvoice(f, { status: 'void', issueDate: '2026-08-12' });
  await seedLine(f, voided, { sourceType: 'catalog', quantity: '1.00', unitPrice: '888.00', costBasis: '1.00' });
  const september = await seedInvoice(f, { status: 'sent', issueDate: '2026-09-01' });
  await seedLine(f, september, { sourceType: 'catalog', quantity: '1.00', unitPrice: '777.00', costBasis: '1.00' });

  return { f, inPeriod: [august, goods, labor, accepted], excluded: [july, draft, voided, september], overageLineId: overage!.id };
}

/** Every line of the given invoices, as the reference fold reads them. */
async function referenceLines(invoiceIds: string[], overageLineId: string): Promise<ReferenceLine[]> {
  const rows = await getTestDb().select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, invoiceIds));
  return rows.map((l) => ({
    id: l.id, parentLineId: l.parentLineId, sourceType: l.sourceType as ReferenceLine['sourceType'],
    catalogItemId: l.catalogItemId, quantity: l.quantity, unitPrice: l.unitPrice, costBasis: l.costBasis,
    customerVisible: l.customerVisible, blockOverage: l.id === overageLineId,
  }));
}

const foldAsSystem = (scope: Parameters<typeof invoiceLineFoldQuery>[0]['scope'], period = AUGUST) =>
  withSystemDbAccessContext(async () => rowsOf<LineFoldRow>(await db.execute(invoiceLineFoldQuery({ scope, ...period }))));

describe('client profitability statements — real Postgres (#9828 W3)', () => {
  runDb('the SQL fold equals the reference fold over the same seeded lines, per category', async () => {
    const s = await seedAll();
    const rows = await foldAsSystem({ kind: 'partner', partnerId: s.f.partnerId, orgIds: [s.f.orgId] });
    const ref = referenceFold(await referenceLines(s.inPeriod, s.overageLineId), 'USD');

    expect(rows.every((r) => r.org_id === s.f.orgId && r.currency_code === 'USD')).toBe(true);
    const byCategory = Object.fromEntries(rows.map((r) => [r.category, {
      revenue: r.revenue, costBearingRevenue: r.cost_bearing_revenue, cost: r.cost, unknownCostRevenue: r.unknown_cost_revenue,
      linesMissingCost: r.lines_missing_cost, partialCostBundles: r.partial_cost_bundles,
    }]));
    // numeric(…) text: normalize to 2 dp before comparing with the reference strings.
    const norm = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? Number(v).toFixed(2) : v]));
    expect(Object.keys(byCategory).sort()).toEqual(Object.keys(ref.byCategory).sort());
    for (const [category, totals] of Object.entries(ref.byCategory)) {
      expect(norm(byCategory[category]!), category).toEqual(totals);
    }

    // The trap fixtures, read straight off the SQL rows.
    const cat = (c: string) => rows.find((r) => r.category === c)!;
    expect(Number(cat('recurring').revenue)).toBe(1000);           // the August block fee only
    expect(Number(cat('labor').revenue)).toBe(150 + 142.5 + 23.75); // overage line + the all-labor invoice
    expect(Number(cat('labor').cost_bearing_revenue)).toBe(0);      // T2
    expect(Number(cat('product').cost)).toBe(160 + 320 + 300);      // bundle cost once (T1); accepted product stamped
    expect(cat('product').partial_cost_bundles).toBe(1);            // T10
    expect(Number(cat('product').unknown_cost_revenue)).toBe(400);
    expect(Number(cat('other').cost)).toBe(0.02);                   // 0.00 known + the half-cent tie rounded up
    expect(Number(cat('ai').unknown_cost_revenue)).toBe(12.34);
  });

  runDb('a JPY client: cost rounds per line at 0 dp', async () => {
    const f = await seedBlockFixture({ currency: 'JPY', nextBillingAt: null });
    const inv = await seedInvoice(f, { status: 'sent', issueDate: '2026-08-05' });
    await seedLine(f, inv, { sourceType: 'catalog', quantity: '0.50', unitPrice: '4.00', costBasis: '1.00' });
    await seedLine(f, inv, { sourceType: 'catalog', quantity: '0.50', unitPrice: '4.00', costBasis: '1.00' });
    const [row] = await foldAsSystem({ kind: 'organization', orgId: f.orgId });
    expect(row).toMatchObject({ currency_code: 'JPY', category: 'product' });
    expect(Number(row!.cost)).toBe(2); // ¥0.5 → ¥1 per line, twice; never ROUND(Σ 1.0) = 1
  });

  runDb('the explicit predicate is the fence: a foreign org in the allowlist reads nothing at partner scope', async () => {
    const s = await seedAll();
    const other = await seedBlockFixture({ nextBillingAt: null });
    const foreignInvoice = await seedInvoice(other, { status: 'paid', issueDate: '2026-08-10' });
    await seedLine(other, foreignInvoice, { sourceType: 'catalog', quantity: '1.00', unitPrice: '555.00', costBasis: '5.00' });

    const rows = await foldAsSystem({ kind: 'partner', partnerId: s.f.partnerId, orgIds: [s.f.orgId, other.orgId] });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.org_id === other.orgId)).toBe(false);

    // And at org scope the org's own partner is enforced, not a bound id.
    const orgRows = await foldAsSystem({ kind: 'organization', orgId: other.orgId });
    expect(orgRows.map((r) => r.org_id)).toEqual([other.orgId]);
  });

  runDb('request-context parity: the partner RLS context reads the same rows as system scope', async () => {
    const s = await seedAll();
    const scope = { kind: 'partner' as const, partnerId: s.f.partnerId, orgIds: [s.f.orgId] };
    const ctx = { scope: 'partner', orgId: null, accessibleOrgIds: [s.f.orgId], accessiblePartnerIds: [s.f.partnerId], currentPartnerId: s.f.partnerId, userId: null } as never;
    const asPartner = await withDbAccessContext(ctx, async () => rowsOf<LineFoldRow>(await db.execute(invoiceLineFoldQuery({ scope, ...AUGUST }))));
    expect(asPartner).toEqual(await foldAsSystem(scope));
  });

  runDb('invoice detail at org scope: one row per in-period invoice, categories split, excluded invoices absent', async () => {
    const s = await seedAll();
    const rows = await withSystemDbAccessContext(async () => rowsOf<Record<string, unknown>>(
      await db.execute(invoiceDetailQuery({ orgId: s.f.orgId, ...AUGUST, limit: 100 }))));
    expect(rows.map((r) => r.invoice_id).sort()).toEqual([...s.inPeriod].sort());
    expect(rows.every((r) => r.available === 4)).toBe(true);
    const august = rows.find((r) => r.invoice_id === s.inPeriod[0])!;
    expect(Number(august.recurring_revenue)).toBe(1000);
    expect(Number(august.labor_revenue)).toBe(150);
  });

  runDb('hours: completed entries by coverage, running timers excluded, org-less row at partner scope only; owner-tz instants', async () => {
    const f = await seedBlockFixture({ nextBillingAt: null });
    const insert = (o: Partial<typeof timeEntries.$inferInsert> & { startedAt: Date }) =>
      getTestDb().insert(timeEntries).values({
        partnerId: f.partnerId, orgId: f.orgId, userId: f.userId, description: 'Work', isBillable: true,
        currencyCode: f.currency, durationMinutes: 60, endedAt: new Date(o.startedAt.getTime() + 3_600_000), ...o,
      } as never);
    await insert({ startedAt: new Date('2026-08-03T15:00:00Z'), coverage: 'billable', durationMinutes: 90 });
    await insert({ startedAt: new Date('2026-08-04T15:00:00Z'), coverage: 'included', durationMinutes: 45 });
    await insert({ startedAt: new Date('2026-08-05T15:00:00Z'), coverage: null, isBillable: false, durationMinutes: 30 });
    // 23:30 on Aug 31 in New York = 03:30Z Sep 1 — inside the NY period.
    await insert({ startedAt: new Date('2026-09-01T03:30:00Z'), coverage: 'billable', durationMinutes: 20 });
    // 00:30 on Aug 1 in New York is inside; 23:30 on Jul 31 New York (03:30Z Aug 1) is not.
    await insert({ startedAt: new Date('2026-08-01T03:30:00Z'), coverage: 'billable', durationMinutes: 999 });
    await insert({ startedAt: new Date('2026-08-06T15:00:00Z'), coverage: 'billable', durationMinutes: null, endedAt: null }); // running
    await insert({ startedAt: new Date('2026-08-07T15:00:00Z'), orgId: null, currencyCode: null, coverage: 'non_billable', durationMinutes: 15 });

    const period = resolveReportPeriod({ kind: 'custom', start: '2026-08-01', end: '2026-08-31' }, 'America/New_York', new Date('2026-09-10T00:00:00Z'));
    expect(localPeriodDates(period)).toEqual({ startDate: AUGUST.periodStartDate, endDate: AUGUST.periodEndDate });
    const read = (scope: Parameters<typeof hoursQuery>[0]['scope']) => withSystemDbAccessContext(async () =>
      rowsOf<HoursRow>(await db.execute(hoursQuery({ scope, periodStart: period.start, periodEnd: period.end }))));

    const partnerRows = await read({ kind: 'partner', partnerId: f.partnerId, orgIds: [f.orgId] });
    const orgRow = partnerRows.find((r) => r.org_id === f.orgId)!;
    expect(orgRow).toMatchObject({ currency_code: f.currency, billable_minutes: 110, included_minutes: 45, non_billable_minutes: 30 });
    expect(partnerRows.find((r) => r.org_id === null)).toMatchObject({ currency_code: null, non_billable_minutes: 15, billable_minutes: 0 });
    expect(partnerRows).toHaveLength(2);

    const orgRows = await read({ kind: 'organization', orgId: f.orgId });
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0]).toMatchObject({ org_id: f.orgId, billable_minutes: 110 });
  });

  runDb('another partner sees no hours: the partner axis is bound even when the org id is listed', async () => {
    const f = await seedBlockFixture({ nextBillingAt: null });
    const other = await createPartner({});
    const otherOrg = await createOrganization({ partnerId: other.id, name: 'Elsewhere' });
    await getTestDb().insert(timeEntries).values({
      partnerId: f.partnerId, orgId: f.orgId, userId: f.userId, description: 'Work', isBillable: true, currencyCode: f.currency,
      startedAt: new Date('2026-08-03T15:00:00Z'), endedAt: new Date('2026-08-03T16:00:00Z'), durationMinutes: 60, coverage: 'billable',
    } as never);
    const rows = await withSystemDbAccessContext(async () => rowsOf<HoursRow>(await db.execute(hoursQuery({
      scope: { kind: 'partner', partnerId: other.id, orgIds: [f.orgId, otherOrg.id] },
      periodStart: new Date('2026-08-01T00:00:00Z'), periodEnd: new Date('2026-09-01T00:00:00Z'),
    }))));
    expect(rows).toEqual([]);
  });
});
