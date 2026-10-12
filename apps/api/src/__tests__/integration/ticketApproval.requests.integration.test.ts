/**
 * Customer work approval W02 Task 2 (#4617 spec §5.3, §6.1): gate context,
 * pending-request create/join with the whole-ticket ask, and recipient
 * resolution — against real Postgres under a PARTNER-scope request context.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { ticketApprovalRequests } from '../../db/schema';
import {
  afterEntryLeftRequest, holdEntryOnRequest, loadGateContext, loadPlainApprovalSettings, resolveRecipients,
} from '../../services/ticketApproval/requests';
import {
  addContact, ctx, insertSettledEntry, readEntry, readRequest, readRequests, seedApprovalFixture, type ApprovalFixture,
} from './ticketApprovalFixtures';

const RUN = !!process.env.DATABASE_URL;

/** Run `fn` the way a writer does: partner context, ticket row locked first. */
function underTicketLock<T>(f: ApprovalFixture, fn: () => Promise<T>, ticketId = f.ticketId): Promise<T> {
  return withDbAccessContext(ctx(f), async () => {
    await db.execute(sql`SELECT id FROM tickets WHERE id = ${ticketId}::uuid FOR UPDATE`);
    return fn();
  });
}

async function hold(f: ApprovalFixture, entryId: string, trigger: 'budget' | 'after_hours' = 'budget', ticketId = f.ticketId) {
  return underTicketLock(f, () => holdEntryOnRequest(db, {
    ticketId, orgId: f.orgId, trigger, enforcement: 'soft', ttlHours: 72, currencyCode: 'USD', entryId,
    afterHoursWorkTypeId: trigger === 'after_hours' ? f.afterHoursWorkTypeId : null,
  }), ticketId);
}

describe.runIf(RUN)('approval requests: create / join / ask (spec §5.3)', () => {
  it('the first hold creates a pending auto request at revision 1 with the snapshot figures', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    await insertSettledEntry(f, 90);
    const entry = await insertSettledEntry(f, 60);
    const res = await hold(f, entry);
    expect(res.created).toBe(true);
    const req = await readRequest(res.requestId);
    expect(req).toMatchObject({
      status: 'pending', origin: 'auto', trigger: 'budget', revision: 1, enforcement: 'soft',
      budgetMinutesAtRequest: 120, consumedMinutesAtRequest: 90, requestedExtensionMinutes: 30,
      requestedExtensionAmount: null, currencyCode: 'USD',
    });
    expect(req.expiresAt.getTime() - Date.now()).toBeGreaterThan(71 * 3600_000);
    const e = await readEntry(entry);
    expect(e.billingStatus).toBe('awaiting_approval');
    expect(e.approvalRequestId).toBe(res.requestId);
  });

  it('a second hold joins it: revision 2 and the ask is recomputed over the whole ticket', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    await insertSettledEntry(f, 90);
    const a = await insertSettledEntry(f, 60);
    const b = await insertSettledEntry(f, 20);
    const first = await hold(f, a);
    const second = await hold(f, b);
    expect(second).toMatchObject({ requestId: first.requestId, created: false, revision: 2 });
    const req = await readRequest(first.requestId);
    // 90 consumed + 80 held − 120 ceiling = 50 → rounded up to 60.
    expect(req).toMatchObject({ revision: 2, requestedExtensionMinutes: 60 });
    expect(await readRequests(f.ticketId)).toHaveLength(1);
  });

  it('asks over the whole ticket, never the sum of per-entry overages (budget 60, consumed 50, two held 30s)', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 50);
    const a = await insertSettledEntry(f, 30);
    const b = await insertSettledEntry(f, 30);
    const { requestId } = await hold(f, a);
    await hold(f, b);
    // Whole ticket: 50 + 60 − 60 = 50 → ceil15 = 60. Per-entry: (50+30−60)×2 = 40 → 45 (under-asks).
    expect((await readRequest(requestId)).requestedExtensionMinutes).toBe(60);
  });

  it('a money-only overage stores the minutes ask as NULL (CHECK IS NULL OR > 0) and the amount in currency', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: null, budgetAmount: '100.00' });
    await insertSettledEntry(f, 48); // 0.80h × 100 = 80.00
    const a = await insertSettledEntry(f, 18); // 0.30h × 100 = 30.00
    const { requestId } = await hold(f, a);
    expect(await readRequest(requestId)).toMatchObject({
      requestedExtensionMinutes: null, requestedExtensionAmount: '10.00',
      budgetAmountAtRequest: '100.00', consumedAmountAtRequest: '80.00', currencyCode: 'USD',
    });
  });

  it('an after-hours hold creates a separate request with the work-type snapshot', async () => {
    const f = await seedApprovalFixture();
    const a = await insertSettledEntry(f, 30);
    const b = await insertSettledEntry(f, 30);
    const budget = await hold(f, a, 'budget');
    const ah = await hold(f, b, 'after_hours');
    expect(ah.requestId).not.toBe(budget.requestId);
    expect(await readRequest(ah.requestId)).toMatchObject({
      trigger: 'after_hours', afterHoursWorkTypeId: f.afterHoursWorkTypeId, requestedExtensionMinutes: null,
    });
  });

  it('an emptied auto request is cancelled; a non-empty one is re-asked at the next revision', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    const a = await insertSettledEntry(f, 50);
    const b = await insertSettledEntry(f, 50);
    const { requestId } = await hold(f, a);
    await hold(f, b);
    // Release `a` (as an edit that now fits would) and settle the request.
    const ev1 = await underTicketLock(f, async () => {
      await db.execute(sql`UPDATE time_entries SET billing_status = 'not_billed', approval_request_id = NULL WHERE id = ${a}::uuid`);
      return afterEntryLeftRequest(db, requestId, { ttlHours: 72, author: { kind: 'staff', userId: f.userId } });
    });
    expect(ev1).toMatchObject({ type: 'ticket.approval_requested', payload: { requestId, revision: 3 } });
    // 50 consumed + 50 held − 60 = 40 → 45.
    expect(await readRequest(requestId)).toMatchObject({ status: 'pending', requestedExtensionMinutes: 45 });
    const ev2 = await underTicketLock(f, async () => {
      await db.execute(sql`UPDATE time_entries SET billing_status = 'not_billed', approval_request_id = NULL WHERE id = ${b}::uuid`);
      return afterEntryLeftRequest(db, requestId, { ttlHours: 72, author: { kind: 'staff', userId: f.userId } });
    });
    expect(ev2).toMatchObject({ type: 'ticket.approval_decided', payload: { requestId, status: 'cancelled' } });
    expect((await readRequest(requestId)).status).toBe('cancelled');
  });
});

describe.runIf(RUN)('loadGateContext (spec §5.3–§5.4), partner-scope RLS', () => {
  it('sums settled billable time only, excluding held, running, non-billable and the excluded entry', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    await insertSettledEntry(f, 30);
    await insertSettledEntry(f, 15, { billingStatus: 'billed' });
    await insertSettledEntry(f, 10, { billingStatus: 'contract' });
    const excluded = await insertSettledEntry(f, 40);
    const held = await insertSettledEntry(f, 25);
    await hold(f, held);
    const c = await underTicketLock(f, () => loadGateContext(db, {
      ticketId: f.ticketId, partnerId: f.partnerId, orgId: f.orgId, excludeEntryId: excluded,
      entryStartedAt: new Date(), workTypeId: f.afterHoursWorkTypeId,
    }));
    expect(c.consumed.minutes).toBe(55);
    expect(c.pendingBudgetRequest).toBe(true); // visible under partner-scope RLS
    expect(c.isAfterHoursWorkType).toBe(true);
    expect(c.settings.enabled).toBe(true);
  });

  it('ignoreRequestId lifts the queue rule for that request only', async () => {
    const f = await seedApprovalFixture();
    const e = await insertSettledEntry(f, 200);
    const { requestId } = await hold(f, e);
    const c = await underTicketLock(f, () => loadGateContext(db, {
      ticketId: f.ticketId, partnerId: f.partnerId, orgId: f.orgId, ignoreRequestId: requestId,
      entryStartedAt: new Date(), workTypeId: null,
    }));
    expect(c.pendingBudgetRequest).toBe(false);
  });

  it('after-hours coverage: an approved staff window, an approved auto link, or an unchanged budget link', async () => {
    const f = await seedApprovalFixture();
    const start = new Date('2026-10-06T22:00:00Z');
    const [win] = await withSystemDbAccessContext(() => db.insert(ticketApprovalRequests).values({
      orgId: f.orgId, ticketId: f.ticketId, trigger: 'after_hours', origin: 'staff', status: 'approved', enforcement: 'soft',
      expiresAt: new Date(), coverageStartsAt: new Date('2026-10-06T20:00:00Z'), coverageEndsAt: new Date('2026-10-07T02:00:00Z'),
      decidedAt: new Date(), decisionOrigin: 'on_behalf', decisionMethod: 'verbal', decisionReference: 'call', decidedRevision: 1,
    }).returning({ id: ticketApprovalRequests.id }));
    const load = (o: Partial<Parameters<typeof loadGateContext>[1]>) => underTicketLock(f, () => loadGateContext(db, {
      ticketId: f.ticketId, partnerId: f.partnerId, orgId: f.orgId, entryStartedAt: start, workTypeId: f.afterHoursWorkTypeId, ...o,
    }));
    expect((await load({})).afterHoursCovered).toBe(true);
    expect((await load({ entryStartedAt: new Date('2026-10-07T02:00:00Z') })).afterHoursCovered).toBe(false); // half-open
    const e = await insertSettledEntry(f, 30);
    const { requestId: budgetReq } = await hold(f, e, 'budget');
    const outside = new Date('2026-10-01T22:00:00Z');
    expect((await load({ entryStartedAt: outside, currentRequestId: budgetReq })).afterHoursCovered).toBe(false);
    expect((await load({ entryStartedAt: outside, currentRequestId: budgetReq, afterHoursFactsUnchanged: true })).afterHoursCovered).toBe(true);
    expect(win).toBeDefined();
  });

  it('disabled policy resolves enabled=false (the writers short-circuit on it)', async () => {
    const f = await seedApprovalFixture({ enabled: false });
    const s = await underTicketLock(f, () => loadPlainApprovalSettings(db, { partnerId: f.partnerId, orgId: f.orgId }));
    expect(s.enabled).toBe(false);
  });
});

describe.runIf(RUN)('resolveRecipients (spec §6.1)', () => {
  it('billing contact → approver; requester → notify; a requester who is also billing → approver only', async () => {
    const f = await seedApprovalFixture();
    await addContact(f, 'Billing@Example.test', [{ role: 'billing' }]);
    const requester = await addContact(f, 'requester@example.test', [{ role: 'technical' }]);
    await addContact(f, 'site-billing@example.test', [{ role: 'billing', siteScoped: true }]);
    await addContact(f, 'billing@example.test', [{ role: 'billing' }], f.otherOrgId); // another org
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE tickets SET requester_contact_id = ${requester}::uuid WHERE id = ${f.ticketId}::uuid`));
    const r1 = await underTicketLock(f, () => resolveRecipients(db, { orgId: f.orgId, ticketId: f.ticketId, trigger: 'budget' }));
    expect(r1).toEqual({ approverEmails: ['billing@example.test'], notifyEmails: ['requester@example.test'] });

    await withSystemDbAccessContext(() => db.execute(sql`UPDATE tickets SET requester_contact_id = NULL, submitter_email = 'BILLING@example.test' WHERE id = ${f.ticketId}::uuid`));
    const r2 = await underTicketLock(f, () => resolveRecipients(db, { orgId: f.orgId, ticketId: f.ticketId, trigger: 'budget' }));
    expect(r2).toEqual({ approverEmails: ['billing@example.test'], notifyEmails: [] });
  });

  it('after-hours contacts are notified only for the after_hours trigger', async () => {
    const f = await seedApprovalFixture();
    await addContact(f, 'night@example.test', [{ role: 'after_hours' }]);
    const budget = await underTicketLock(f, () => resolveRecipients(db, { orgId: f.orgId, ticketId: f.ticketId, trigger: 'budget' }));
    const ah = await underTicketLock(f, () => resolveRecipients(db, { orgId: f.orgId, ticketId: f.ticketId, trigger: 'after_hours' }));
    expect(budget.notifyEmails).toEqual([]);
    expect(ah.notifyEmails).toEqual(['night@example.test']);
  });

  it('with no billing contact, approverEmails is [] and the request is still created', async () => {
    const f = await seedApprovalFixture();
    const r = await underTicketLock(f, () => resolveRecipients(db, { orgId: f.orgId, ticketId: f.ticketId, trigger: 'budget' }));
    expect(r.approverEmails).toEqual([]);
    const e = await insertSettledEntry(f, 200);
    const { requestId } = await hold(f, e);
    expect((await readRequest(requestId)).approverEmails).toEqual([]);
  });
});
