import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, contractLines, contracts, invoiceLines } from '../../db/schema';
import { cancelContract, generateDueInvoice, pauseContract, resumeContract } from '../../services/contractService';
import { claimPeriod, entryState, seedBlockFixture, seedEntry } from './hourBlockFixtures';

const run = (contractId: string, at: string) =>
  withSystemDbAccessContext(() => generateDueInvoice(contractId, new Date(`${at}T06:00:00Z`)));
const linesOf = (invoiceId: string) => withSystemDbAccessContext(() =>
  db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));

describe('generateDueInvoice with a block of hours (real DB) #8181', () => {
  it('arrears: fee and that period\'s overage on one invoice', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(f, { minutes: 720, endedAt: '2026-07-15T12:00:00Z' });           // 12 h, 2 over
    const r = await run(f.contractId, '2026-08-01');
    expect(r.generated).toBe(true);
    expect(r.hourBlockCloses).toHaveLength(1);
    expect(r.hourBlockCloses[0]).toMatchObject({ periodStart: '2026-07-01', overageHours: 2 });
    const lines = await linesOf(r.invoiceId!);
    expect(lines.map((l) => [l.description, l.quantity, l.unitPrice])).toEqual([
      ['Support hours', '1.00', '1000.00'],
      ['Support hours — hours over block, 2026-07-01 – 2026-08-01', '2.00', '150.00'],
    ]);
    expect(r.overages).toEqual([]);   // device-unit overages never carry hours (index delta 7)
  });

  it('advance: P0 overage lands on the P1 invoice with P0\'s dates', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01' });
    const r0 = await run(f.contractId, '2026-07-01');
    expect(r0.hourBlockCloses).toEqual([]);
    expect(await linesOf(r0.invoiceId!)).toHaveLength(1);
    await seedEntry(f, { minutes: 660, endedAt: '2026-07-20T12:00:00Z' });           // 11 h, 1 over
    const r1 = await run(f.contractId, '2026-08-01');
    const lines = await linesOf(r1.invoiceId!);
    expect(lines.map((l) => l.description)).toEqual([
      'Support hours', 'Support hours — hours over block, 2026-07-01 – 2026-08-01',
    ]);
  });

  it('pause gap grants no hours', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await run(f.contractId, '2026-08-01');                                        // claims + closes July
    await withSystemDbAccessContext(() => pauseContract(f.contractId, f.actor));
    const pausedWork = await seedEntry(f, { minutes: 60, endedAt: '2026-08-15T12:00:00Z' });
    await withSystemDbAccessContext(() => resumeContract(f.contractId, f.actor, '2026-10-05'));
    await run(f.contractId, '2026-11-01');
    const rows = await withSystemDbAccessContext(() => db.select({ s: contractHourPeriods.periodStart })
      .from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)).orderBy(contractHourPeriods.periodStart));
    expect(rows.map((r) => r.s)).toEqual(['2026-07-01', '2026-10-01']);        // August/September never closed
    expect((await entryState(pausedWork)).billingStatus).toBe('not_billed');   // bills ad hoc
  });

  it('a block added mid-period on an active advance contract does not absorb that period', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-08-01', firstPeriodStart: '2026-08-01' });
    // July was claimed before the block existed.
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const julyWork = await seedEntry(f, { minutes: 60, endedAt: '2026-07-20T12:00:00Z' });
    await run(f.contractId, '2026-08-01');
    expect((await entryState(julyWork)).billingStatus).toBe('not_billed');
  });

  it('a retired line bills no fee', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await withSystemDbAccessContext(() => db.insert(contractLines).values({
      contractId: f.contractId, orgId: f.orgId, lineType: 'flat', description: 'Managed services', unitPrice: '500.00', taxable: true,
    }));
    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date('2026-06-30T00:00:00Z') })
      .where(eq(contractLines.id, f.blockLineId)));
    const r = await run(f.contractId, '2026-08-01');
    expect((await linesOf(r.invoiceId!)).map((l) => l.description)).toEqual(['Managed services']);
  });

  it('a contract whose only line is a retired block generates nothing', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date('2026-06-30T00:00:00Z') })
      .where(eq(contractLines.id, f.blockLineId)));
    const r = await run(f.contractId, '2026-08-01');
    expect(r).toMatchObject({ generated: false, skipped: 'not_due', hourBlockCloses: [] });
  });

  it('expiry and cancellation retire the live block line', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', endDate: '2026-08-01' });
    await run(f.contractId, '2026-08-01');                                        // bills July, then expires
    const [l] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, f.blockLineId)));
    expect(l!.hourBlockRetiredAt).not.toBeNull();

    const g = await seedBlockFixture({ timing: 'arrears' });
    await withSystemDbAccessContext(() => cancelContract(g.contractId, g.actor));
    const [m] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, g.blockLineId)));
    expect(m!.hourBlockRetiredAt).not.toBeNull();
  });

  it('expiry at the due check (no bill this run) also retires the live block line', async () => {
    // Arrears, pointer at 09-01: the run covers August, which starts on the end date.
    const f = await seedBlockFixture({ timing: 'arrears', endDate: '2026-08-01', nextBillingAt: '2026-09-01' });
    const r = await run(f.contractId, '2026-09-01');
    expect(r).toMatchObject({ generated: false, skipped: 'expired', hourBlockCloses: [], hourBlockCloseTruncated: false });
    const [l] = await withSystemDbAccessContext(() => db.select().from(contractLines).where(eq(contractLines.id, f.blockLineId)));
    expect(l!.hourBlockRetiredAt).not.toBeNull();
  });

  it('a retired line is skipped by the close step (its periods belong to the close-out sweep)', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await withSystemDbAccessContext(() => db.insert(contractLines).values({
      contractId: f.contractId, orgId: f.orgId, lineType: 'flat', description: 'Managed services', unitPrice: '500.00', taxable: true,
    }));
    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: new Date('2026-07-15T00:00:00Z') })
      .where(eq(contractLines.id, f.blockLineId)));
    const e = await seedEntry(f, { minutes: 60, endedAt: '2026-07-10T12:00:00Z' });
    const r = await run(f.contractId, '2026-08-01');
    expect(r.generated).toBe(true);
    expect(r.hourBlockCloses).toEqual([]);
    expect((await entryState(e)).billingStatus).toBe('not_billed');
  });

  it('a re-run is already_billed and closes nothing twice', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-15T12:00:00Z' });
    await run(f.contractId, '2026-08-01');
    await withSystemDbAccessContext(() => db.update(contracts).set({ nextBillingAt: '2026-08-01' }).where(eq(contracts.id, f.contractId)));
    const again = await run(f.contractId, '2026-08-01');
    expect(again).toMatchObject({ generated: false, skipped: 'already_billed', hourBlockCloses: [] });
    const rows = await withSystemDbAccessContext(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    expect(rows).toHaveLength(1);
  });
});
