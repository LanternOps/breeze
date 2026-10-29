import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contractLines, contracts, invoiceLines, invoices } from '../../db/schema';
import { createManualInvoice, issueInvoice } from '../../services/invoiceService';
import { computeOpenHourBlockPeriod } from '../../services/contractHourBlockEstimate';
import { generateDueInvoice } from '../../services/contractService';
import { entryState, seedBlockFixture, seedEntry, type BlockFixture } from './hourBlockFixtures';

/**
 * #8970 — a draft that picked up block-period time before the hold applied
 * (built before the block line went live, while the contract was paused, or by
 * void-and-reissue) must not bill that time hourly ahead of the period close;
 * and the live "used" figure must not count time a draft can still bill hourly.
 */
const sys = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const partnerCtx = (partnerId: string, orgIds: string[]) =>
  ({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null }) as never;
const actorOf = (f: BlockFixture) => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });

/** A draft carrying `entryIds` as hourly lines, seeded directly (assembly would hold them). */
async function seedDraft(f: BlockFixture, entryIds: string[]) {
  return sys(async () => {
    const inv = await createManualInvoice({ orgId: f.orgId, currencyCode: f.currency }, actorOf(f));
    for (const id of entryIds) {
      await db.insert(invoiceLines).values({
        invoiceId: inv.id, orgId: f.orgId, sourceType: 'time_entry', sourceId: id,
        description: 'Labour', quantity: '1.00', unitPrice: '120.00', lineTotal: '120.00', taxable: true,
      });
    }
    return inv;
  });
}

async function liveEstimate(f: BlockFixture, asOf: Date) {
  return sys(async () => {
    const [c] = await db.select().from(contracts).where(eq(contracts.id, f.contractId));
    const [line] = await db.select().from(contractLines).where(eq(contractLines.id, f.blockLineId));
    return { c: c!, line: line! };
  }).then(({ c, line }) => withDbAccessContext(partnerCtx(f.partnerId, [f.orgId]), () => computeOpenHourBlockPeriod(c, line, asOf)));
}

describe('issueInvoice re-checks block-of-hours hold windows (real DB) #8970', () => {
  it('refuses a draft whose time is held for a live block: 409 SOURCE_HELD_FOR_HOUR_BLOCK, nothing flips, the close still draws it', async () => {
    // Active arrears contract, block live; July is the period the next run claims → held.
    const f = await seedBlockFixture({ timing: 'arrears' });
    const held = await seedEntry(f, { minutes: 120, endedAt: '2026-07-15T12:00:00Z' });
    const draft = await seedDraft(f, [held]);

    await expect(sys(() => issueInvoice(draft.id, actorOf(f))))
      .rejects.toMatchObject({ status: 409, code: 'SOURCE_HELD_FOR_HOUR_BLOCK' });
    expect(await entryState(held)).toEqual({ billingStatus: 'not_billed', contractLineId: null });
    const [inv] = await sys(() => db.select({ status: invoices.status, number: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, draft.id)));
    expect(inv).toEqual({ status: 'draft', number: null });

    const r = await sys(() => generateDueInvoice(f.contractId, new Date('2026-08-01T06:00:00Z')));
    expect(r.hourBlockCloses).toMatchObject([{ entryCount: 1, consumedHours: 2 }]);
    expect(await entryState(held)).toEqual({ billingStatus: 'contract', contractLineId: f.blockLineId });
  });

  it('issues hourly time that no hold window covers (paused contract, unclaimed period)', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', status: 'paused' });
    const e = await seedEntry(f, { minutes: 120, endedAt: '2026-07-15T12:00:00Z' });
    const draft = await seedDraft(f, [e]);
    await sys(() => issueInvoice(draft.id, actorOf(f)));
    expect((await entryState(e)).billingStatus).toBe('billed');
  });

  it('a non-billable entry inside a window does not trip the gate (the close never draws non-billable time)', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const nb = await seedEntry(f, { minutes: 60, endedAt: '2026-07-15T12:00:00Z', isBillable: false });
    const draft = await seedDraft(f, [nb]);
    await sys(() => issueInvoice(draft.id, actorOf(f)));
    expect((await entryState(nb)).billingStatus).toBe('billed');
  });
});

describe('live block estimate and on-draft time (real DB) #8970', () => {
  const AS_OF = new Date('2026-07-20T12:00:00Z');

  it('not active: time already on an open draft is excluded from "used" (the draft can bill it hourly); loose time and void-invoice time still count', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', status: 'paused' });
    const onDraft = await seedEntry(f, { minutes: 120, endedAt: '2026-07-10T12:00:00Z' });
    const loose = await seedEntry(f, { minutes: 60, endedAt: '2026-07-11T12:00:00Z' });
    const onVoid = await seedEntry(f, { minutes: 30, endedAt: '2026-07-12T12:00:00Z' });
    await seedDraft(f, [onDraft]);
    const voided = await seedDraft(f, [onVoid]);
    await sys(() => db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, voided.id)));

    const out = await liveEstimate(f, AS_OF);
    expect(out.consumedHours).toBe(1.5);
  });

  it('active: held time on a draft still counts — Issue refuses that draft and the close draws the time', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const onDraft = await seedEntry(f, { minutes: 120, endedAt: '2026-07-10T12:00:00Z' });
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-11T12:00:00Z' });
    await seedDraft(f, [onDraft]);

    const out = await liveEstimate(f, AS_OF);
    expect(out.consumedHours).toBe(3);
  });
});
