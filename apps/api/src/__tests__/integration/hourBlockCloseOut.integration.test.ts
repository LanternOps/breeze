import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, contractLines, contracts, invoiceLines, invoices, organizations } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { closeHourBlockPeriods, runHourBlockCloseOutSweep } from '../../services/contractHourBlockClose';
import { entryState, seedBlockFixture, seedEntry } from './hourBlockFixtures';

const at = (d: string) => new Date(`${d}T06:00:00Z`);

describe('runHourBlockCloseOutSweep (real DB) #8181', () => {
  it('advance contract expiring: the final period closes after it ends, overage on a new draft', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    const r = await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01'))); // claims July, expires
    expect(r.generated).toBe(true);
    await seedEntry(f, { minutes: 720, endedAt: '2026-07-25T12:00:00Z' });             // 2 h over

    expect(await runHourBlockCloseOutSweep(at('2026-07-28'))).toMatchObject({ closes: 0 }); // not ended yet
    const s = await runHourBlockCloseOutSweep(at('2026-08-02'));
    expect(s).toMatchObject({ closes: 1, errors: 0 });

    const [row] = await withSystemDbAccessContext(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    expect(row).toMatchObject({ periodStart: '2026-07-01', overageHours: '2.00', closeSource: 'close_out' });
    const [inv] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, row!.overageInvoiceId!)));
    expect(inv!.status).toBe('draft');
    expect(inv!.id).not.toBe(r.invoiceId);
    const lines = await withSystemDbAccessContext(() => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv!.id)));
    expect(lines.map((l) => l.description)).toEqual(['Support hours — hours over block, 2026-07-01 – 2026-08-01']);
  });

  it('cancelled mid-period with no overage: closes, marks entries, creates no invoice', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01' });
    await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
    await withSystemDbAccessContext(() => db.update(contracts).set({ status: 'cancelled', nextBillingAt: null }).where(eq(contracts.id, f.contractId)));
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    const before = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.orgId, f.orgId)));
    await runHourBlockCloseOutSweep(at('2026-08-02'));
    const after = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.orgId, f.orgId)));
    expect(after).toHaveLength(before.length);
    expect(await entryState(e)).toEqual({ billingStatus: 'contract', contractLineId: f.blockLineId });
  });

  it('is idempotent and leaves active live blocks to the billing run', async () => {
    const live = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(live, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    expect(await runHourBlockCloseOutSweep(at('2026-08-02'))).toMatchObject({ closes: 0 });
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
    await runHourBlockCloseOutSweep(at('2026-08-02'));
    expect(await runHourBlockCloseOutSweep(at('2026-08-03'))).toMatchObject({ closes: 0 });
  });

  it('the expiring run\'s final period closes even when the server TimeZone is not UTC', async () => {
    // contract_billing_periods.generated_at is timestamp WITHOUT time zone; the
    // claim and the retirement share one now(). Under a non-UTC session zone a
    // naive read would put the claim hours after the retirement and lose it.
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    const r = await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
      return generateDueInvoice(f.contractId, at('2026-07-01'));
    });
    expect(r.generated).toBe(true);
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-25T12:00:00Z' });
    const s = await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL TimeZone = 'Pacific/Kiritimati'`);
      const [c] = await db.select().from(contracts).where(eq(contracts.id, f.contractId));
      const [l] = await db.select().from(contractLines).where(eq(contractLines.id, f.blockLineId));
      return closeHourBlockPeriods({
        contract: c!, line: l!, closeSource: 'close_out', asOf: at('2026-08-02'),
        overageInvoice: async () => { throw new Error('no overage expected'); },
      });
    });
    expect(s.closes.map((c) => c.periodStart)).toEqual(['2026-07-01']);
  });

  it('skips a contract whose org is not automation-eligible', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
    await withSystemDbAccessContext(() => db.update(organizations).set({ status: 'archived' } as never).where(eq(organizations.id, f.orgId)));
    expect(await runHourBlockCloseOutSweep(at('2026-08-02'))).toMatchObject({ contracts: 0, closes: 0 });
  });

  it('a sweep racing a manual generate on the same contract closes each period once', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
    await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-10T12:00:00Z' });
    const sweeps = await Promise.all([runHourBlockCloseOutSweep(at('2026-08-02')), runHourBlockCloseOutSweep(at('2026-08-02'))]);
    expect(sweeps.map((x) => x.errors)).toEqual([0, 0]);
    expect(sweeps.reduce((n, x) => n + x.closes, 0)).toBe(1);
    const rows = await withSystemDbAccessContext(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    expect(rows).toHaveLength(1);
  });
});
