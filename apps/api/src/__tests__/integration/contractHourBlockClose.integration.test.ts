import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, contractLines, contracts, invoiceLines } from '../../db/schema';
import { closeHourBlockPeriods } from '../../services/contractHourBlockClose';
import { createManualInvoice } from '../../services/invoiceService';
import { claimPeriod, entryState, seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';

const AS_OF = new Date('2026-08-01T06:00:00Z');

async function loadRows(f: BlockFixture) {
  return withSystemDbAccessContext(async () => {
    const [c] = await db.select().from(contracts).where(eq(contracts.id, f.contractId));
    const [l] = await db.select().from(contractLines).where(eq(contractLines.id, f.blockLineId));
    return { contract: c!, line: l! };
  });
}

async function close(f: BlockFixture, asOf = AS_OF) {
  return withSystemDbAccessContext(async () => {
    const { contract, line } = await loadRows(f);
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: f.currency }, actor);
    const r = await closeHourBlockPeriods({ contract, line, overageInvoice: { id: inv.id, actor }, closeSource: 'billing_run', asOf });
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    return { ...r, invoiceId: inv.id, lines };
  });
}

async function ledger(f: BlockFixture) {
  return withSystemDbAccessContext(() => db.select().from(contractHourPeriods)
    .where(eq(contractHourPeriods.contractLineId, f.blockLineId)).orderBy(contractHourPeriods.periodStart));
}

describe('closeHourBlockPeriods (real DB) #8181', () => {
  it('under the block: ledger row, entries marked, no overage line', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const a = await seedEntry(f, { minutes: 240, endedAt: '2026-07-10T12:00:00Z' });
    const b = await seedEntry(f, { minutes: 150, endedAt: '2026-07-31T23:59:00Z' });
    const r = await close(f);
    expect(r.closes).toHaveLength(1);
    expect(r.closes[0]).toMatchObject({ periodStart: '2026-07-01', periodEnd: '2026-08-01', consumedHours: 6.5, overageHours: 0, entryCount: 2, overageInvoiceLineId: null });
    expect(r.lines).toHaveLength(0);
    expect(await entryState(a)).toEqual({ billingStatus: 'contract', contractLineId: f.blockLineId });
    expect(await entryState(b)).toEqual({ billingStatus: 'contract', contractLineId: f.blockLineId });
    expect(await ledger(f)).toHaveLength(1);
  });

  it('over the block: one aggregate overage line at the contracted rate', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 600, endedAt: '2026-07-10T12:00:00Z' });
    await seedEntry(f, { minutes: 140, endedAt: '2026-07-11T12:00:00Z' });   // 2.33 h
    const r = await close(f);
    expect(r.closes[0]).toMatchObject({ consumedHours: 12.33, overageHours: 2.33 });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      description: 'Support hours — hours over block, 2026-07-01 – 2026-08-01',
      quantity: '2.33', unitPrice: '150.00', lineTotal: '349.50',
      sourceType: 'contract', sourceId: f.blockLineId, sourceContractId: f.contractId,
      parentLineId: null, catalogItemId: null, taxable: true,
    });
    const [row] = await ledger(f);
    expect(row).toMatchObject({ overageHours: '2.33', overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run' });
    expect(row!.overageInvoiceId).toBe(r.invoiceId);
  });

  it('boundary: an entry ending exactly at periodEnd belongs to the next period', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const inside = await seedEntry(f, { minutes: 60, endedAt: '2026-07-01T00:00:00Z' });
    const next = await seedEntry(f, { minutes: 60, endedAt: '2026-08-01T00:00:00Z' });
    await close(f);
    expect((await entryState(inside)).billingStatus).toBe('contract');
    expect((await entryState(next)).billingStatus).toBe('not_billed');
  });

  it('reads COALESCE(billable_minutes, duration_minutes)', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 20, billableMinutes: 30, endedAt: '2026-07-10T12:00:00Z' }); // seedEntry sets minimumMinutes 30
    const r = await close(f);
    expect(r.closes[0]!.consumedHours).toBe(0.5);
  });

  it('ignores no_charge, non-billable, already-billed and card-included entries', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const nc = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', billingStatus: 'no_charge' });
    const nb = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', isBillable: false });
    const inc = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', billingStatus: 'contract', hourlyRate: null });
    const r = await close(f);
    expect(r.closes[0]).toMatchObject({ consumedHours: 0, entryCount: 0 });
    expect(await entryState(nc)).toEqual({ billingStatus: 'no_charge', contractLineId: null });
    expect(await entryState(nb)).toEqual({ billingStatus: 'not_billed', contractLineId: null });
    expect(await entryState(inc)).toEqual({ billingStatus: 'contract', contractLineId: null });
  });

  it('draws unapproved, NULL-rate and foreign-currency entries; flags the foreign hours', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', isApproved: false });
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z', hourlyRate: null });
    await seedEntry(f, { minutes: 90, endedAt: '2026-07-10T12:00:00Z', currencyCode: 'EUR' });
    const r = await close(f);
    expect(r.closes[0]).toMatchObject({ consumedHours: 3.5, foreignCurrencyHours: 1.5, entryCount: 3 });
  });

  it('carries forward across three periods, earliest first, in one call', async () => {
    const f = await seedBlockFixture({ rollover: 'carry_forward', cap: '4.00' });
    for (const [s, e] of [['2026-07-01', '2026-08-01'], ['2026-08-01', '2026-09-01'], ['2026-09-01', '2026-10-01']] as const) await claimPeriod(f, s, e);
    await seedEntry(f, { minutes: 240, endedAt: '2026-07-10T12:00:00Z' });  // 4 h used -> 6 left, capped 4
    await seedEntry(f, { minutes: 780, endedAt: '2026-08-10T12:00:00Z' });  // 13 h of 14 -> 1 left
    await seedEntry(f, { minutes: 720, endedAt: '2026-09-10T12:00:00Z' });  // 12 h of 11 -> 1 over
    const r = await close(f, new Date('2026-10-01T06:00:00Z'));
    expect(r.closes.map((c) => [c.periodStart, c.carriedInHours, c.consumedHours, c.overageHours, c.carriedOutHours])).toEqual([
      ['2026-07-01', 0, 4, 0, 4], ['2026-08-01', 4, 13, 0, 1], ['2026-09-01', 1, 12, 1, 0],
    ]);
  });

  it('is idempotent: a second call closes nothing and adds no line', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-10T12:00:00Z' });
    await close(f);
    const again = await close(f);
    expect(again.closes).toEqual([]);
    expect(again.lines).toEqual([]);
    expect(await ledger(f)).toHaveLength(1);
  });

  it('never closes an unclaimed period and never one before the first block period', async () => {
    const f = await seedBlockFixture({ firstPeriodStart: '2026-08-01' });
    await claimPeriod(f, '2026-07-01', '2026-08-01');            // claimed, but before the block
    const early = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    const unclaimed = await seedEntry(f, { minutes: 60, endedAt: '2026-08-10T12:00:00Z' });
    const r = await close(f, new Date('2026-09-02T06:00:00Z'));
    expect(r.closes).toEqual([]);
    expect((await entryState(early)).billingStatus).toBe('not_billed');
    expect((await entryState(unclaimed)).billingStatus).toBe('not_billed');
  });

  it('the overage rate and currency are snapshot at close', async () => {
    const f = await seedBlockFixture();
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 660, endedAt: '2026-07-10T12:00:00Z' });
    await close(f);
    await withSystemDbAccessContext(() => db.update(contractLines).set({ overageUnitPrice: '999.00' }).where(eq(contractLines.id, f.blockLineId)));
    const [row] = await ledger(f);
    expect(row!.overageUnitPrice).toBe('150.00');
  });
});
