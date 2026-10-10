import './setup';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contractHourPeriods, contractLines } from '../../db/schema';
import { gatherOrgTimeEntries, gatherTicketBillables } from '../../services/invoiceAssembly';
import { assembleDraftFromOrg } from '../../services/invoiceService';
import { hourBlockHoldWindows } from '../../services/contractHourBlockClose';
import { claimPeriod, seedBlockFixture, seedEntry } from './hourBlockFixtures';

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-12-31T23:59:59Z');

describe('ad-hoc assembly holds block-covered time (real DB) #8181', () => {
  it('holds open-period entries and reports them; bills the rest', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-08-01', startDate: '2026-07-01', firstPeriodStart: '2026-07-01' });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    const held = await seedEntry(f, { minutes: 90, endedAt: '2026-07-20T12:00:00Z' });
    const before = await seedEntry(f, { minutes: 60, endedAt: '2026-06-20T12:00:00Z' });
    const r = await withSystemDbAccessContext(() => gatherOrgTimeEntries(f.orgId, FROM, TO, 'USD', new Date('2026-07-25T00:00:00Z')));
    expect(r.included.map((l) => l.sourceId)).toEqual([before]);
    expect(r.heldForHourBlock).toEqual({ count: 1, hours: 1.5 });
    expect(r.included.map((l) => l.sourceId)).not.toContain(held);
  });

  it('does not hold entries in a closed period (late entry) or in an unclaimed pause gap', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', nextBillingAt: '2026-11-01' });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await withSystemDbAccessContext(() => db.insert(contractHourPeriods).values({
      contractLineId: f.blockLineId, contractId: f.contractId, orgId: f.orgId, periodStart: '2026-07-01', periodEnd: '2026-08-01',
      includedHours: '10.00', carriedInHours: '0.00', consumedHours: '0.00', overageHours: '0.00', carriedOutHours: '0.00',
      foreignCurrencyHours: '0.00', entryCount: 0, overageUnitPrice: '150.00', currencyCode: 'USD', closeSource: 'billing_run',
    }));
    const late = await seedEntry(f, { minutes: 60, endedAt: '2026-07-20T12:00:00Z' });
    const gap = await seedEntry(f, { minutes: 60, endedAt: '2026-08-20T12:00:00Z' });
    const r = await withSystemDbAccessContext(() => gatherOrgTimeEntries(f.orgId, FROM, TO, 'USD', new Date('2026-10-15T00:00:00Z')));
    expect(r.included.map((l) => l.sourceId).sort()).toEqual([late, gap].sort());
    expect(r.heldForHourBlock).toEqual({ count: 0, hours: 0 });
  });

  it('holds the final claimed period of a cancelled contract until the sweep closes it', async () => {
    const f = await seedBlockFixture({ timing: 'advance', status: 'cancelled', nextBillingAt: null });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await seedEntry(f, { minutes: 60, endedAt: '2026-07-20T12:00:00Z' });
    const w = await withSystemDbAccessContext(() => hourBlockHoldWindows(f.orgId, new Date('2026-07-25T00:00:00Z')));
    expect(w).toEqual([{ start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z'), contractLineId: f.blockLineId }]);
  });

  it('arrears: holds the just-ended period until the run claims it', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', nextBillingAt: '2026-08-01' });   // July unclaimed until the 08-01 run
    const julyWork = await seedEntry(f, { minutes: 60, endedAt: '2026-07-30T12:00:00Z' });
    const r = await withSystemDbAccessContext(() => gatherOrgTimeEntries(f.orgId, FROM, TO, 'USD', new Date('2026-08-01T02:00:00Z')));
    expect(r.included.map((l) => l.sourceId)).not.toContain(julyWork);
    expect(r.heldForHourBlock.count).toBe(1);
  });

  it('a retired line holds only periods claimed while it was live, and opens no forward window', async () => {
    const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-09-01' });
    await claimPeriod(f, '2026-07-01', '2026-08-01');
    await new Promise((r) => setTimeout(r, 20));
    // Retired between the two claims: August's claim is after retirement, so not entitled.
    await withSystemDbAccessContext(() => db.update(contractLines).set({ hourBlockRetiredAt: sql`now()` })
      .where(eq(contractLines.id, f.blockLineId)));
    await new Promise((r) => setTimeout(r, 20));
    await claimPeriod(f, '2026-08-01', '2026-09-01');
    const w = await withSystemDbAccessContext(() => hourBlockHoldWindows(f.orgId, new Date('2026-08-20T00:00:00Z')));
    expect(w).toEqual([{ start: new Date('2026-07-01T00:00:00Z'), end: new Date('2026-08-01T00:00:00Z'), contractLineId: f.blockLineId }]);
  });

  it('the ticket gatherer holds the same entries and reports them', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', nextBillingAt: '2026-08-01' });
    const ticketId = randomUUID();
    await getTestDb().execute(sql`INSERT INTO tickets (id, partner_id, org_id, ticket_number, subject, source)
      VALUES (${ticketId}, ${f.partnerId}, ${f.orgId}, ${`HB-${ticketId}`}, 'Block hold', 'manual')`);
    const held = await seedEntry(f, { minutes: 30, endedAt: '2026-07-20T12:00:00Z', ticketId });
    const before = await seedEntry(f, { minutes: 60, endedAt: '2026-06-20T12:00:00Z', ticketId });
    const r = await withSystemDbAccessContext(() => gatherTicketBillables(ticketId, 'USD', new Date('2026-07-25T00:00:00Z')));
    expect(r.included.map((l) => l.sourceId)).toEqual([before]);
    expect(r.included.map((l) => l.sourceId)).not.toContain(held);
    expect(r.heldForHourBlock).toEqual({ count: 1, hours: 0.5 });
  });

  it('an empty ad-hoc assembly names the held hours in its 409', async () => {
    const f = await seedBlockFixture({ timing: 'arrears', nextBillingAt: '2026-08-01' });
    await seedEntry(f, { minutes: 90, endedAt: '2026-07-20T12:00:00Z' });
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
    const err = await withSystemDbAccessContext(() => assembleDraftFromOrg({ orgId: f.orgId, from: '2026-07-01', to: '2026-07-31' }, actor))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'NOTHING_TO_INVOICE', details: { heldForHourBlock: { count: 1, hours: 1.5 } } });
    expect((err as Error).message).toMatch(/1 entry \(1\.5 h\) is held for a block of hours/);
  });

  it('works in a partner-scoped request context (Shape-1 reads only)', async () => {
    const f = await seedBlockFixture({ timing: 'arrears' });
    const w = await withDbAccessContext({
      scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId],
      currentPartnerId: f.partnerId, userId: f.userId,
    }, () => hourBlockHoldWindows(f.orgId, new Date('2026-07-25T00:00:00Z')));
    expect(w).toEqual([{ start: new Date('2026-07-01T00:00:00Z'), end: null, contractLineId: f.blockLineId }]);
  });
});
