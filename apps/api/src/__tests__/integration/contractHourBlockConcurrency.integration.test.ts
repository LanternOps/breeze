import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, invoiceLines, timeEntries } from '../../db/schema';
import { generateDueInvoice } from '../../services/contractService';
import { createManualInvoice, issueInvoice } from '../../services/invoiceService';
import { updateTimeEntry } from '../../services/timeEntryService';
import { seedBlockFixture, seedEntry, systemActor } from './hourBlockFixtures';

const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const AT = new Date('2026-08-01T06:00:00Z');

describe('block close concurrency (real DB) #8181', () => {
  it('close vs. issueInvoice over the same entries: one winner, a clean 409, no hour on both', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const e = await seedEntry(f, { minutes: 120, endedAt: '2026-07-15T12:00:00Z' });
    const draft = await sys(() => seedAdHocDraft(f, e));
    const results = await Promise.allSettled([
      sys(() => generateDueInvoice(f.contractId, AT)),
      sys(() => issueInvoice(draft.id, { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] })),
    ]);
    const issue = results[1];
    const [row] = await sys(() => db.select({ s: timeEntries.billingStatus, l: timeEntries.contractLineId }).from(timeEntries).where(eq(timeEntries.id, e)));
    if (row!.s === 'contract') {
      expect(issue.status).toBe('rejected');
      expect((issue as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'SOURCE_ALREADY_BILLED' });
    } else {
      expect(row!.s).toBe('billed');
      const [ledger] = await sys(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
      expect(ledger!.entryCount).toBe(0);
    }
    expectNoFault(results);
  });

  it('ordered: close commits first -> the ad-hoc issue is a clean 409 SOURCE_ALREADY_BILLED', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const e = await seedEntry(f, { minutes: 120, endedAt: '2026-07-15T12:00:00Z' });
    const draft = await sys(() => seedAdHocDraft(f, e));
    await sys(() => generateDueInvoice(f.contractId, AT));
    await expect(sys(() => issueInvoice(draft.id, { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] })))
      .rejects.toMatchObject({ status: 409, code: 'SOURCE_ALREADY_BILLED' });
    const [row] = await sys(() => db.select({ s: timeEntries.billingStatus, l: timeEntries.contractLineId }).from(timeEntries).where(eq(timeEntries.id, e)));
    expect(row).toEqual({ s: 'contract', l: f.blockLineId });
  });

  it('ordered: ad-hoc issue commits first -> the close skips the billed entry', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const e = await seedEntry(f, { minutes: 120, endedAt: '2026-07-15T12:00:00Z' });
    const draft = await sys(() => seedAdHocDraft(f, e));
    await sys(() => issueInvoice(draft.id, { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] }));
    const r = await sys(() => generateDueInvoice(f.contractId, AT));
    expect(r.hourBlockCloses).toMatchObject([{ entryCount: 0, consumedHours: 0 }]);
    const [row] = await sys(() => db.select({ s: timeEntries.billingStatus, l: timeEntries.contractLineId }).from(timeEntries).where(eq(timeEntries.id, e)));
    expect(row).toEqual({ s: 'billed', l: null });
  });

  it('a duration edit racing a close: the ledger matches exactly the rows it marked', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const ids = await Promise.all([1, 2, 3].map(() => seedEntry(f, { minutes: 60, endedAt: '2026-07-15T12:00:00Z' })));
    const results = await Promise.allSettled([
      sys(() => generateDueInvoice(f.contractId, AT)),
      sys(() => updateTimeEntry(ids[1]!, { endedAt: new Date('2026-07-15T14:00:00Z') }, systemActor(f))),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    if (results[1]!.status === 'rejected') {
      expect(results[1]!.reason).toMatchObject({ status: 409, code: 'ENTRY_DRAWN_BY_BLOCK' });
    }
    expectNoFault(results);
    const marked = await sys(() => db.select({ m: sql<number>`COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes})`.mapWith(Number) })
      .from(timeEntries).where(eq(timeEntries.contractLineId, f.blockLineId)));
    const [ledger] = await sys(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    const expected = marked.reduce((n, r) => n + Math.round((r.m * 100) / 60), 0) / 100;
    expect(Number(ledger!.consumedHours)).toBe(expected);
    expect(ledger!.entryCount).toBe(marked.length);
  });

  it('two billing runs at once: one invoice, one ledger row', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    await seedEntry(f, { minutes: 700, endedAt: '2026-07-15T12:00:00Z' });
    const rs = await Promise.all([sys(() => generateDueInvoice(f.contractId, AT)), sys(() => generateDueInvoice(f.contractId, AT))]);
    expect(rs.filter((r) => r.generated)).toHaveLength(1);
    const rows = await sys(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, f.blockLineId)));
    expect(rows).toHaveLength(1);
    const overageLines = await sys(() => db.select().from(invoiceLines).where(eq(invoiceLines.sourceId, f.blockLineId)));
    expect(overageLines.filter((l) => (l.description ?? '').includes('hours over block'))).toHaveLength(1);
  });
});

/** Neither side may fail with a 500 or a Postgres deadlock (40P01). */
function expectNoFault(results: PromiseSettledResult<unknown>[]) {
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    const reason = r.reason as { status?: number; code?: string };
    expect(reason.status, String(r.reason)).not.toBe(500);
    expect(reason.code, String(r.reason)).not.toBe('40P01');
  }
}

/** An ad-hoc draft carrying the entry, seeded directly: assembly (Task 6) now
 *  holds block-covered time, so this is the shape of a draft built before the
 *  block existed — exactly the one that can still race the close. */
async function seedAdHocDraft(f: { orgId: string; partnerId: string; userId: string; currency: string }, entryId: string) {
  const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
  const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: f.currency }, actor);
  await db.insert(invoiceLines).values({
    invoiceId: inv.id, orgId: f.orgId, sourceType: 'time_entry', sourceId: entryId,
    description: 'Labour', quantity: '2.00', unitPrice: '120.00', lineTotal: '240.00', taxable: true,
  });
  return inv;
}
