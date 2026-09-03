/**
 * #3205 W04 (#4607) acceptance bar: the allowance boundary matrix against real
 * Postgres as breeze_app, asserting QUANTITIES, per-line totals, subtotal, TAX
 * and total — because 'bill' at N+1 changes the tax base, which quantities alone
 * would not catch.
 *
 * Canonical fixture: included_quantity = 25, unit_price = 10.00,
 * overage_unit_price = 12.00, taxable, org tax rate 0.10, USD.
 *
 * setup.ts TRUNCATEs before every test, so each test seeds its own org inline.
 * devices.site_id is NOT NULL — every billable device gets the org's site.
 */
import './setup';

import { describe, expect, it, vi } from 'vitest';

// Fire-and-forget BullMQ side effects are not the correctness under test (same
// rationale as multiCurrencyWave6ContractBilling.integration.test.ts).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  contractBillingPeriods, contractLines, contracts, devices, invoiceLines, invoices,
  organizationUsers, organizations, partners, roles, sites, users,
} from '../../db/schema';
import { computeContractEstimate, generateDueInvoice, type ContractActorT } from '../../services/contractService';
import { createCatalogItemWithPrice } from './db-utils';

const SWEEP_AT = new Date('2026-07-01T06:00:00Z');
const TAX_RATE = '0.10000';

interface Fixture { partnerId: string; orgId: string; siteId: string; contractId: string; actor: ContractActorT }

async function seed(opts: { devices?: number; currency?: string } = {}): Promise<Fixture> {
  const currency = opts.currency ?? 'USD';
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `OV ${sfx}`, slug: `ov-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: currency, partnerId: p!.id, name: 'OVOrg', slug: `ov-${sfx}`, taxRate: TAX_RATE })
      .returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `HQ-${sfx}` }).returning({ id: sites.id });
    const n = opts.devices ?? 0;
    if (n > 0) {
      await db.insert(devices).values(Array.from({ length: n }, (_, i) => ({
        orgId: o!.id, siteId: s!.id, agentId: `ov-${sfx}-${i}`, hostname: `ov-${i}`, status: 'online' as const,
        deviceRole: 'workstation', osType: 'linux' as const, osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0',
      })));
    }
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'Allowance contract', status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: currency, billingTiming: 'advance',
    }).returning({ id: contracts.id });
    return {
      partnerId: p!.id, orgId: o!.id, siteId: s!.id, contractId: c!.id,
      actor: { userId: null as unknown as string, partnerId: p!.id, accessibleOrgIds: [o!.id] },
    };
  });
}

/** Insert a contract line directly: the writers are covered by their own unit
 *  tests, and the catalog/price-book variants below need shapes the writers
 *  deliberately refuse to create. */
async function addLine(f: Fixture, o: Partial<typeof contractLines.$inferInsert> = {}) {
  const [row] = await withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, lineType: 'per_device', description: 'Endpoints',
    unitPrice: '10.00', taxable: true, ...o,
  }).returning({ id: contractLines.id }));
  return row!.id;
}

async function readInvoice(invoiceId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({ subtotal: invoices.subtotal, taxTotal: invoices.taxTotal, total: invoices.total })
    .from(invoices).where(eq(invoices.id, invoiceId)).limit(1));
  return row!;
}

async function readLines(invoiceId: string) {
  return withSystemDbAccessContext(() => db.select({
    id: invoiceLines.id, description: invoiceLines.description, quantity: invoiceLines.quantity, unitPrice: invoiceLines.unitPrice,
    lineTotal: invoiceLines.lineTotal, taxable: invoiceLines.taxable, customerVisible: invoiceLines.customerVisible,
    costBasis: invoiceLines.costBasis, catalogItemId: invoiceLines.catalogItemId,
    parentLineId: invoiceLines.parentLineId, sourceId: invoiceLines.sourceId,
    sourceContractId: invoiceLines.sourceContractId, sortOrder: invoiceLines.sortOrder,
  }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));
}

const BILL = { includedQuantity: '25.00', overageMode: 'bill' as const, overageUnitPrice: '12.00' };
const FLAG = { includedQuantity: '25.00', overageMode: 'flag' as const, overageUnitPrice: null };
const NONE = { includedQuantity: null, overageMode: null, overageUnitPrice: null };

describe('allowance + overage generation (real DB) #3205 W04', () => {
  // counted, mode, base qty, subtotal, tax, total, overage line?, overages[] length
  it.each<[number, 'none' | 'bill' | 'flag', string, string, string, string, boolean, number]>([
    [0,  'none', '0.00',  '0.00',   '0.00',  '0.00',   false, 0],
    [24, 'none', '24.00', '240.00', '24.00', '264.00', false, 0],
    [25, 'none', '25.00', '250.00', '25.00', '275.00', false, 0],
    [26, 'none', '26.00', '260.00', '26.00', '286.00', false, 0],
    [0,  'bill', '25.00', '250.00', '25.00', '275.00', false, 0],
    [24, 'bill', '25.00', '250.00', '25.00', '275.00', false, 0],
    [25, 'bill', '25.00', '250.00', '25.00', '275.00', false, 0],
    [26, 'bill', '25.00', '250.00', '25.00', '275.00', true,  1],
    [0,  'flag', '25.00', '250.00', '25.00', '275.00', false, 0],
    [24, 'flag', '25.00', '250.00', '25.00', '275.00', false, 0],
    [25, 'flag', '25.00', '250.00', '25.00', '275.00', false, 0],
    [26, 'flag', '25.00', '250.00', '25.00', '275.00', false, 1],
  ])('counted %d, mode %s', async (counted, mode, baseQty, subtotal, tax, total, hasOverageLine, overageCount) => {
    const f = await seed({ devices: counted });
    const spec = mode === 'bill' ? BILL : mode === 'flag' ? FLAG : NONE;
    const lineId = await addLine(f, spec);

    // The estimate and generation must agree on counted / billed / overage —
    // and, because every line in this matrix is non-catalog, on MONEY too.
    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contractId, f.actor));
    expect(est.lines[0]).toMatchObject({ counted, quantity: Number(baseQty) });
    expect(est.overages).toHaveLength(overageCount);
    expect(est.periodTotal).toBe(hasOverageLine ? '262.00' : subtotal);

    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(res.generated).toBe(true);
    expect(res.overages).toHaveLength(overageCount);

    const lines = await readLines(res.invoiceId!);
    expect(lines).toHaveLength(hasOverageLine ? 2 : 1);
    expect(lines[0]).toMatchObject({ description: 'Endpoints', quantity: baseQty, unitPrice: '10.00' });

    if (hasOverageLine) {
      // The sibling: a real, editable, customer-visible charge — NOT a bundle child.
      expect(lines[1]).toMatchObject({
        description: 'Overage: 1 above 25 included — Endpoints',
        quantity: '1.00', unitPrice: '12.00', lineTotal: '12.00',
        taxable: true, customerVisible: true, catalogItemId: null,
        parentLineId: null, sourceId: lineId, sourceContractId: f.contractId,
      });
      expect(lines[1]!.sortOrder).toBe(lines[0]!.sortOrder + 1);
      // 'bill' at 26 moves the TAX BASE — the reason this matrix asserts tax.
      expect(await readInvoice(res.invoiceId!)).toEqual({ subtotal: '262.00', taxTotal: '26.20', total: '288.20' });
    } else {
      expect(await readInvoice(res.invoiceId!)).toEqual({ subtotal, taxTotal: tax, total });
    }

    if (overageCount > 0) {
      expect(res.overages[0]).toEqual({
        contractLineId: lineId, invoiceLineId: hasOverageLine ? lines[1]!.id : null,
        description: 'Endpoints', counted, included: 25, overage: 1, mode,
      });
    }
  });

  it('flag mode at 26 writes EXACTLY one invoice line — it never silently invoices', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, FLAG);
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(await readLines(res.invoiceId!)).toHaveLength(1);
    expect(res.overages[0]!.mode).toBe('flag');
  });

  it('interleaves each bill overage sibling directly below its base across multiple contract lines', async () => {
    const f = await seed({ devices: 26 });
    const billLineId = await addLine(f, { ...BILL, description: 'Bill endpoints', sortOrder: 0 });
    const flagLineId = await addLine(f, { ...FLAG, description: 'Flag endpoints', sortOrder: 1 });
    await addLine(f, { ...NONE, description: 'All endpoints', sortOrder: 2 });

    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);

    expect(lines.map((line) => line.description)).toEqual([
      'Bill endpoints',
      'Overage: 1 above 25 included — Bill endpoints',
      'Flag endpoints',
      'All endpoints',
    ]);
    expect(lines.map((line) => line.sortOrder)).toEqual([1, 2, 3, 4]);
    expect(res.overages).toEqual([
      { contractLineId: billLineId, invoiceLineId: lines[1]!.id, description: 'Bill endpoints', counted: 26, included: 25, overage: 1, mode: 'bill' },
      { contractLineId: flagLineId, invoiceLineId: null, description: 'Flag endpoints', counted: 26, included: 25, overage: 1, mode: 'flag' },
    ]);
  });

  it('an overage price of 0.00 still writes a customer-visible zero-value line', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, { includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '0.00' });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ quantity: '1.00', unitPrice: '0.00', lineTotal: '0.00', customerVisible: true });
    // Totals are identical to the flag row: the count is on the document, at no charge.
    expect(await readInvoice(res.invoiceId!)).toEqual({ subtotal: '250.00', taxTotal: '25.00', total: '275.00' });
  });

  it('a catalog-priced base bills the allowance at the CURRENT catalog price; the overage leg is untouched', async () => {
    const f = await seed({ devices: 24 });
    const item = await createCatalogItemWithPrice({ partnerId: f.partnerId, name: 'Managed endpoint', unitPrice: '11.00', currencyCode: 'USD', costBasis: '4.00' });
    await addLine(f, { ...BILL, catalogItemId: item.id, unitPrice: '10.00' });  // stamp 10.00, book 11.00
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines).toHaveLength(1);                       // 24 < 25: no overage
    expect(lines[0]).toMatchObject({ quantity: '25.00', unitPrice: '11.00', lineTotal: '275.00' });
    expect(res.priceBookGaps).toEqual([]);
  });

  it('a catalog line with no price in the contract currency reports a price-book gap and still bills the allowance', async () => {
    const f = await seed({ devices: 26 });
    const item = await createCatalogItemWithPrice({ partnerId: f.partnerId, name: 'EUR-only item', unitPrice: '9.00', currencyCode: 'EUR' });
    const lineId = await addLine(f, { ...BILL, catalogItemId: item.id, unitPrice: '10.00' });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(res.priceBookGaps).toEqual([{ contractLineId: lineId, catalogItemId: item.id, itemName: 'Endpoints', currencyCode: 'USD' }]);
    const lines = await readLines(res.invoiceId!);
    // Base billed at the stamp; the overage leg is NEVER catalog-priced, so it
    // can never itself be a gap (contractService.ts's gap push requires catalogItemId).
    expect(lines[0]).toMatchObject({ quantity: '25.00', unitPrice: '10.00' });
    expect(lines[1]).toMatchObject({ quantity: '1.00', unitPrice: '12.00', catalogItemId: null });
    expect(res.priceBookGaps).toHaveLength(1);
  });

  it('the overage line inherits the MATERIALIZED base line taxable flag and per-unit cost basis', async () => {
    const f = await seed({ devices: 26 });
    // The catalog resolver owns taxability on a catalog line and ignores the
    // contract line's flag — so reading l.taxable could tax the overage
    // differently from the thing it is an overage of (decision 9).
    const item = await createCatalogItemWithPrice({ partnerId: f.partnerId, name: 'Taxable item', unitPrice: '10.00', currencyCode: 'USD', costBasis: '4.00' });
    await addLine(f, { ...BILL, catalogItemId: item.id, taxable: false });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines[1]!.taxable).toBe(lines[0]!.taxable);
    expect(lines[1]!.costBasis).toBe(lines[0]!.costBasis);
    expect(lines[1]!.costBasis).not.toBeNull();
  });

  it('per_seat carries the same shapes', async () => {
    const f = await seed();
    await withSystemDbAccessContext(async () => {
      const sfx = Math.random().toString(36).slice(2, 8);
      const [r] = await db.insert(roles)
        .values({ name: `SeatRole ${sfx}`, scope: 'organization', partnerId: f.partnerId, orgId: f.orgId })
        .returning({ id: roles.id });
      const seatUsers = await db.insert(users).values(Array.from({ length: 3 }, (_, i) => ({
        partnerId: f.partnerId, orgId: f.orgId, email: `seat-${sfx}-${i}@x.io`, name: `Seat ${i}`, status: 'active' as const,
      }))).returning({ id: users.id });
      await db.insert(organizationUsers).values(seatUsers.map((u) => ({ orgId: f.orgId, userId: u.id, roleId: r!.id })));
    });
    await addLine(f, { lineType: 'per_seat', description: 'Seats', includedQuantity: '2.00', overageMode: 'bill', overageUnitPrice: '12.00' });
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const lines = await readLines(res.invoiceId!);
    expect(lines[0]).toMatchObject({ quantity: '2.00' });
    expect(lines[1]).toMatchObject({ description: 'Overage: 1 above 2 included — Seats', quantity: '1.00', parentLineId: null });
  });

  it('a second July run is not_due and leaves the contract invoice line count unchanged', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, BILL);
    const first = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    const firstLineCount = (await readLines(first.invoiceId!)).length;
    const again = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(again.skipped).toBe('not_due');
    expect(again).toEqual({
      generated: false, autoIssue: false, skipped: 'not_due', priceBookGaps: [],
      uncoveredDevices: null, overages: [],
    });
    expect(firstLineCount).toBe(2);
    expect(await readLines(first.invoiceId!)).toHaveLength(firstLineCount);
    const allInvoices = await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(allInvoices).toHaveLength(1);
  });

  it('ATOMICITY: a failing overage insert rolls back the base line, the invoice, the claim and the pointer', async () => {
    const f = await seed({ devices: 27 });
    // overage = 2 at 9999999999.99 overflows the child line_total's
    // numeric(12,2) (max 9999999999.99) -> Postgres 22003 AFTER the base line
    // committed inside the same transaction.
    await addLine(f, { includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '9999999999.99' });
    await expect(withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT))).rejects.toThrow();

    const [inv] = await withSystemDbAccessContext(() => db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(inv).toBeUndefined();
    const claims = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contractId)));
    expect(claims).toHaveLength(0);
    const [c] = await withSystemDbAccessContext(() => db.select({ nextBillingAt: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, f.contractId)));
    expect(c!.nextBillingAt).toBe('2026-07-01');

    // And the rerun, once the rate is sane, creates exactly one invoice and one claim.
    await withSystemDbAccessContext(() => db.update(contractLines)
      .set({ overageUnitPrice: '12.00' }).where(eq(contractLines.contractId, f.contractId)));
    const res = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT));
    expect(res.generated).toBe(true);
    expect(await readLines(res.invoiceId!)).toHaveLength(2);
    const claimsAfter = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contractId)));
    expect(claimsAfter).toHaveLength(1);
  });

  it('DEFENCE IN DEPTH: a forged unrepresentable rate throws at materialization instead of writing a bad line', async () => {
    // The write-time assertRepresentable is the real guard (Task 2). This proves
    // the second one — addContractLine's non-catalog assertRepresentable
    // (invoiceService.ts:436) — still fires for a row that got in around it.
    const f = await seed({ devices: 26, currency: 'JPY' });
    await addLine(f, { unitPrice: '1000', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.50' });
    await expect(withSystemDbAccessContext(() => generateDueInvoice(f.contractId, SWEEP_AT)))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE' });
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM invoices WHERE org_id = ${f.orgId}::uuid`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });

  it('refuses to run with no ambient DB context, BEFORE any write (decision 14)', async () => {
    const f = await seed({ devices: 26 });
    await addLine(f, BILL);
    await expect(runOutsideDbContext(() => generateDueInvoice(f.contractId, SWEEP_AT)))
      .rejects.toThrow(/generateDueInvoice must run inside withDbAccessContext/);
    const rows = await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM invoices WHERE org_id = ${f.orgId}::uuid`)) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(0);
  });
});
